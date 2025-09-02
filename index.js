const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    }
  }
);

// Helper function to extract text using OCR
async function extractTextWithOCR(pdfBuffer) {
  console.log('Starting OCR extraction...');
  const worker = await createWorker('eng');
  
  try {
    // Convert PDF to images using pdf2pic
    const { fromBuffer } = require('pdf2pic');
    const options = {
      density: 200,
      saveFilename: 'page',
      savePath: path.join(os.tmpdir()),
      format: 'png',
      width: 2000,
      height: 2800
    };
    
    const converter = fromBuffer(pdfBuffer, options);
    const pageCount = 10; // Process first 10 pages for credit reports
    
    let allText = '';
    
    for (let i = 1; i <= pageCount; i++) {
      try {
        const result = await converter(i, { responseType: 'buffer' });
        if (result.buffer) {
          const { data: { text } } = await worker.recognize(result.buffer);
          allText += text + '\n\n';
          console.log(`OCR processed page ${i}`);
        }
      } catch (pageError) {
        console.log(`Could not process page ${i}, continuing...`);
      }
    }
    
    await worker.terminate();
    return allText;
  } catch (error) {
    console.error('OCR extraction failed:', error);
    await worker.terminate();
    throw error;
  }
}

// Helper function to extract text from PDF
async function extractPdfText(pdfBuffer) {
  try {
    // First try standard PDF text extraction
    const data = await pdfParse(pdfBuffer);
    
    if (data.text && data.text.trim().length > 100) {
      console.log('Successfully extracted text from PDF');
      return data.text;
    }
    
    // If no text or very little text, try OCR
    console.log('PDF has no extractable text, attempting OCR...');
    return await extractTextWithOCR(pdfBuffer);
  } catch (error) {
    console.error('Standard PDF extraction failed, attempting OCR...', error);
    return await extractTextWithOCR(pdfBuffer);
  }
}

// Helper function to chunk text
function chunkText(text, maxChunkSize = 12000) {
  const chunks = [];
  const lines = text.split('\n');
  let currentChunk = '';
  
  for (const line of lines) {
    if ((currentChunk + line).length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
    }
    currentChunk += line + '\n';
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

// Helper function to process text chunks with OpenAI
async function processChunksWithOpenAI(chunks, profileId) {
  const allItems = [];
  const systemPrompt = `You are a credit report analyst. Extract ALL credit accounts from the text - both positive and negative.
  
  Return a JSON array where each item has:
  - creditor: string (company name)
  - type: "COLLECTION" | "CHARGE_OFF" | "LATE_PAYMENT" | "JUDGMENT" | "BANKRUPTCY" | "REPOSSESSION" | "FORECLOSURE" | "TAX_LIEN" | "STUDENT_LOAN" | "CREDIT_CARD" | "AUTO_LOAN" | "MORTGAGE" | "PERSONAL_LOAN" | "OTHER"
  - amount: number (in cents, or null if not specified)
  - openedDate: string or null (ISO format)
  - reportedDate: string or null (ISO format)
  - accountLast4: string or null (last 4 digits of account)
  - bureaus: array of strings (["Experian", "Equifax", "TransUnion"] or subset)
  - isNegative: boolean (true if it's a negative item like collection, late payment, charge-off, etc.)
  - notes: string or null (any additional details)
  
  Focus on extracting ALL accounts, marking negative items appropriately.`;
  
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Processing chunk ${i + 1} of ${chunks.length}`);
    
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Extract all credit accounts from this section:\n\n${chunks[i]}` }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      });
      
      const content = response.choices[0].message.content;
      const parsed = JSON.parse(content);
      const items = parsed.items || parsed.accounts || [];
      
      if (Array.isArray(items)) {
        allItems.push(...items);
      }
    } catch (error) {
      console.error(`Error processing chunk ${i + 1}:`, error);
    }
  }
  
  // Deduplicate items
  const uniqueItems = [];
  const seen = new Set();
  
  for (const item of allItems) {
    const key = `${item.creditor}-${item.type}-${item.amount || 0}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueItems.push(item);
    }
  }
  
  return uniqueItems;
}

// Main processing endpoint
app.post('/process', async (req, res) => {
  const { jobId, profileId, filePath, fileName } = req.body;
  
  console.log(`Processing job ${jobId} for profile ${profileId}`);
  console.log(`File: ${fileName} at ${filePath}`);
  
  try {
    // Update job status to processing
    await supabase
      .from('pdf_processing_jobs')
      .update({ 
        status: 'processing',
        started_at: new Date().toISOString()
      })
      .eq('id', jobId);
    
    // Download the PDF from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase
      .storage
      .from('credit-reports')
      .download(filePath);
    
    if (downloadError) {
      throw new Error(`Failed to download file: ${downloadError.message}`);
    }
    
    // Convert blob to buffer
    const arrayBuffer = await fileData.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuffer);
    
    console.log(`Downloaded PDF, size: ${pdfBuffer.length} bytes`);
    
    // Extract text from PDF
    const extractedText = await extractPdfText(pdfBuffer);
    
    if (!extractedText || extractedText.length < 100) {
      throw new Error('Could not extract sufficient text from PDF');
    }
    
    console.log(`Extracted ${extractedText.length} characters from PDF`);
    
    // Chunk the text
    const chunks = chunkText(extractedText);
    console.log(`Split text into ${chunks.length} chunks`);
    
    // Process chunks with OpenAI
    const creditItems = await processChunksWithOpenAI(chunks, profileId);
    console.log(`Found ${creditItems.length} credit items`);
    
    // Save items to database
    for (const item of creditItems) {
      try {
        await supabase
          .from('credit_items')
          .upsert({
            profile_id: profileId,
            creditor: item.creditor,
            type: item.type,
            amount_cents: item.amount,
            opened_date: item.openedDate,
            reported_date: item.reportedDate,
            account_last4: item.accountLast4,
            bureaus: item.bureaus,
            is_negative: item.isNegative,
            notes: item.notes,
            status: 'TO_SEND',
            confidence: 0.8
          });
      } catch (saveError) {
        console.error('Error saving item:', saveError);
      }
    }
    
    // Update job status to completed
    const negativeItems = creditItems.filter(item => item.isNegative);
    
    await supabase
      .from('pdf_processing_jobs')
      .update({ 
        status: 'completed',
        completed_at: new Date().toISOString(),
        result_json: {
          total_items: creditItems.length,
          negative_items: negativeItems.length,
          items_saved: true,
          negative_accounts: negativeItems.map(item => ({
            creditor: item.creditor,
            type: item.type,
            amount_cents: item.amount,
            bureaus: item.bureaus
          }))
        }
      })
      .eq('id', jobId);
    
    res.json({
      success: true,
      jobId,
      totalItems: creditItems.length,
      negativeItems: negativeItems.length
    });
    
  } catch (error) {
    console.error('Processing error:', error);
    
    // Update job status to failed
    await supabase
      .from('pdf_processing_jobs')
      .update({ 
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error.message
      })
      .eq('id', jobId);
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Worker service running on port ${PORT}`);
  console.log('Ready to process PDF jobs');
});
