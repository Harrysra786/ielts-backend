import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra'; // Use fs-extra
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// --- Local Upload Configuration ---
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
// Use path.resolve to ensure it works correctly within Coolify's /app directory
const uploadPath = path.resolve(__dirname, UPLOAD_DIR);

// Ensure the upload directory exists synchronously on startup
try {
    fs.ensureDirSync(uploadPath);
    console.log(`Upload directory ensured at: ${uploadPath}`);
} catch (err) {
    console.error(`Error ensuring upload directory ${uploadPath}:`, err);
    process.exit(1); // Exit if we can't create the essential upload directory
}
// --- End Local Upload Configuration ---

const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : [];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`CORS denied for origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: 'POST, GET, OPTIONS',
    allowedHeaders: 'Content-Type, Authorization',
    credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pre-flight requests
app.use(express.json());

// --- Multer Configuration for Disk Storage ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadPath); // Save files to the resolved upload path
    },
    filename: function (req, file, cb) {
        // Generate a unique filename: fieldname-timestamp-random-extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { files: 3, fileSize: 10 * 1024 * 1024 } // Limit 3 files, 10MB each
});
// --- End Multer Configuration ---

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';
const SITE_NAME = process.env.SITE_NAME || 'Coolify Backend';

async function callOpenRouter(payload) {
    // Check if API key is present
    if (!OPENROUTER_API_KEY) {
        console.error('OpenRouter API Key is missing.');
        throw new Error('Server configuration error: API Key missing.');
    }

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                "HTTP-Referer": SITE_URL,
                "X-Title": SITE_NAME,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('OpenRouter API Error:', response.status, errorText);
            // Try to parse error JSON from OpenRouter if possible
            let detail = errorText;
            try {
                 const errorJson = JSON.parse(errorText);
                 detail = errorJson.error?.message || errorText;
            } catch(e) {
                // Ignore parsing error, use raw text
            }
            throw new Error(`OpenRouter API error: ${response.status} - ${detail}`);
        }

        const data = await response.json();
        if (!data.choices || data.choices.length === 0 || !data.choices[0].message?.content) {
             console.error('Invalid OpenRouter response structure:', JSON.stringify(data, null, 2));
             throw new Error('Invalid response structure from OpenRouter API');
        }
        return data.choices[0].message.content;
    } catch (error) {
        console.error('Error calling OpenRouter:', error);
        // Re-throw the error to be caught by the endpoint handler
        throw error;
    }
}

// --- API Endpoints ---

app.post('/api/essaycriteria', async (req, res) => {
    const { topic, essay } = req.body;

    if (!topic || !essay) {
        return res.status(400).json({ error: 'Missing topic or essay in request body' });
    }

    const prompt = `I will give your an IELTS Essay topic along with the student's full response to it. You are going to provide detailed feedback to this essay in the exact specified format. Your output is going to be a 5 object json:\n\n\nCC (stands for Coherence and Cohesion)\nTA (stands for Task Achievement)\nLR (stands for Lexical Resource)\nGRA (stands for Grammatical Range and Accuracy)\nOverall\n\nThe first four objects here are going to hold 3 keys each: 'score' , 'explanation', and 'examples'.\n\n\nThe 'score' is going to hold a numerical value from 0 to 9 representing the band score.\nThe 'explanation' is going to be a 2-3 sentence explanation for why that score was given. This part should not mention any specific examples.\nThe 'examples' is going to include an array providing specific examples from the essay response quoting verbatim the part from the essay that illistrates the explanation mentioned in the 'explanation' part. The example array should always have the quote followed by a description of the issue. Do no create separate entries for quote and description please. \n\nThe overall is simply a sum of the four 'scores' divided by four.\n\nOne thing to keep in mind is that a score of 5 or less is to be given in any of the four criteria only in cases of essay being incomplete or text being incomprehensible. It is extremely rare for a student to not get at least a 6 on the 4 crtierias. \n\nHere is the essay topic with sample answer:\n\n${topic}\n\n${essay}`;

    try {
        const responseContent = await callOpenRouter({
            model: "microsoft/phi-3.5-mini-128k-instruct",
            response_format: { type: "json_object" },
            messages: [{"role": "user", "content": prompt}],
        });
        try {
            const jsonResponse = JSON.parse(responseContent);
            return res.json(jsonResponse);
        } catch (parseError) {
            console.error("Failed to parse OpenRouter JSON response:", parseError);
            console.error("Raw response:", responseContent); // Log the raw response
            return res.status(500).json({ error: 'Received invalid JSON response from AI service' });
        }
    } catch (error) {
        console.error('Error processing /api/essaycriteria:', error.message);
        return res.status(500).json({ error: error.message || 'An error occurred while processing the essay criteria' });
    }
});

app.post('/api/grammar', async (req, res) => {
    const { essay } = req.body;

    if (!essay) {
        return res.status(400).json({ error: 'Missing essay in request body' });
    }

    const prompt = `Output a grammatically corrected version of this text. Your output should not include anything before or after. Only the corrected grammatical version is expected.\n\nHere is the text:\n\n${essay}`;

    try {
        const responseContent = await callOpenRouter({
            model: "microsoft/phi-3.5-mini-128k-instruct",
            messages: [{"role": "user", "content": prompt}],
        });
        return res.json({ correction: responseContent });
    } catch (error) {
        console.error('Error processing /api/grammar:', error.message);
        return res.status(500).json({ error: error.message || 'An error occurred while processing the grammar correction' });
    }
});

app.post('/api/graphcriteria', async (req, res) => {
    const { topic, essay } = req.body;

    if (!topic || !essay) {
        return res.status(400).json({ error: 'Missing topic or essay in request body' });
    }

    const prompt = `I will give your an IELTS graph (Academic Task 1) topic along with the student's full response to it. You are going to provide detailed feedback to this task in the exact specified format. Your output is going to be a 5 object json:\n\n\nCC (stands for Coherence and Cohesion)\nTA (stands for Task Achievement)\nLR (stands for Lexical Resource)\nGRA (stands for Grammatical Range and Accuracy)\nOverall\n\nThe first four objects here are going to hold 3 keys each: 'score' , 'explanation', and 'examples'.\n\n\nThe 'score' is going to hold a numerical value from 0 to 9 representing the band score.\nThe 'explanation' is going to be a 2-3 sentence explanation for why that score was given. This part should not mention any specific examples.\nThe 'examples' is going to include an array providing specific examples from the graph response quoting verbatim the part from the graph that illustrates the explanation mentioned in the 'explanation' part. The example array should always have the quote followed by a description of the issue. Do no create separate entries for quote and description please. \n\nThe overall is simply a sum of the four 'scores' divided by four.\n\nOne thing to keep in mind is that a score of 5 or less is to be given in any of the four criteria only in cases of graph being incomplete or text being incomprehensible. It is extremely rare for a student to not get at least a 6 on the 4 crtierias. \n\nHere is the graph topic with sample answer:\n\n${topic}\n\n${essay}\n\nNote: Do not prefix your response with anything. Your output must be a pure json in the suggested schema.`;

    try {
        const responseContent = await callOpenRouter({
            model: "nousresearch/hermes-3-llama-3.1-405b",
            response_format: { type: "json_object" },
            messages: [{"role": "user", "content": prompt}],
        });
         try {
            const jsonResponse = JSON.parse(responseContent);
            return res.json(jsonResponse);
        } catch (parseError) {
            console.error("Failed to parse OpenRouter JSON response:", parseError);
            console.error("Raw response:", responseContent);
            return res.status(500).json({ error: 'Received invalid JSON response from AI service' });
        }
    } catch (error) {
        console.error('Error processing /api/graphcriteria:', error.message);
        return res.status(500).json({ error: error.message || 'An error occurred while processing the graph criteria' });
    }
});

app.post('/api/improvement', async (req, res) => {
    const { essay } = req.body;

    if (!essay) {
        return res.status(400).json({ error: 'Missing essay in request body' });
    }

    const prompt = `I want you to write a sentence by sentence improved rephrase for this essay excluding the first and last paragraph. Your output should be an unstyled <table> element (do not wrap it in code block) with left column being 'Your Sentence' and right one 'Improved Sentence'. Each row should be a single sentence from the essay - the original one and the improved. Obviosuly, there are going to be as many rows as the sentences in main body paragraphs.\n\n\nHere is the full essay response:\n\n${essay}`;

    try {
        const responseContent = await callOpenRouter({
            model: "microsoft/phi-3.5-mini-128k-instruct",
            messages: [{"role": "user", "content": prompt}],
        });
        return res.json({ improvement: responseContent });
    } catch (error) {
        console.error('Error processing /api/improvement:', error.message);
        return res.status(500).json({ error: error.message || 'An error occurred while processing the essay improvement' });
    }
});

app.post('/api/improvementgraph', async (req, res) => {
    const { topic, essay } = req.body;

    if (!topic || !essay) {
        return res.status(400).json({ error: 'Missing topic or essay in request body' });
    }

    const prompt = `I want you to write a sentence by sentence improved rephrase for this graph excluding the initial salutation and closing remarks. Your output should be an unstyled <table> element (do not wrap it in code block) with left column being 'Your Sentence' and right one 'Improved Sentence'. Each row should be a single sentence from the graph - the original one and the improved. Obviosuly, there are going to be as many rows as the sentences. \n\n  Here is the topic:\n  ${topic}\n\nHere is the full graph response:\n\n${essay}`;

    try {
        const responseContent = await callOpenRouter({
            model: "microsoft/phi-3.5-mini-128k-instruct",
            messages: [{"role": "user", "content": prompt}],
        });
        return res.json({ improvement: responseContent });
    } catch (error) {
        console.error('Error processing /api/improvementgraph:', error.message);
        return res.status(500).json({ error: error.message || 'An error occurred while processing the graph improvement' });
    }
});

app.post('/api/improvementletter', async (req, res) => {
    const { topic, essay } = req.body;

    if (!topic || !essay) {
        return res.status(400).json({ error: 'Missing topic or essay in request body' });
    }

    const prompt = `I want you to write a sentence by sentence improved rephrase for this letter excluding the initial salutation and closing remarks. Your output should be an unstyled <table> element (do not wrap it in code block) with left column being 'Your Sentence' and right one 'Improved Sentence'. Each row should be a single sentence from the letter - the original one and the improved. Obviosuly, there are going to be as many rows as the sentences. The most important thing - your improvements must align with the tone of the letter. Do not suggest formal sentences for informal letter topic or informal sentences for formal.\n\n  Here is the topic:\n  ${topic}\n\nHere is the full letter response:\n\n${essay}`;

    try {
        const responseContent = await callOpenRouter({
            model: "microsoft/phi-3.5-mini-128k-instruct",
            messages: [{"role": "user", "content": prompt}],
        });
        return res.json({ improvement: responseContent });
    } catch (error) {
        console.error('Error processing /api/improvementletter:', error.message);
        return res.status(500).json({ error: error.message || 'An error occurred while processing the letter improvement' });
    }
});

app.post('/api/lettercriteria', async (req, res) => {
    const { topic, essay } = req.body;

    if (!topic || !essay) {
        return res.status(400).json({ error: 'Missing topic or essay in request body' });
    }

    const prompt = `I will give your an IELTS letter topic along with the student's full response to it. You are going to provide detailed feedback to this task in the exact specified format. Your output is going to be a 5 object json:\n\n\nCC (stands for Coherence and Cohesion)\nTA (stands for Task Achievement)\nLR (stands for Lexical Resource)\nGRA (stands for Grammatical Range and Accuracy)\nOverall\n\nThe first four objects here are going to hold 3 keys each: 'score' , 'explanation', and 'examples'.\n\n\nThe 'score' is going to hold a numerical value from 0 to 9 representing the band score.\nThe 'explanation' is going to be a 2-3 sentence explanation for why that score was given. This part should not mention any specific examples.\nThe 'examples' is going to include an array providing specific examples from the letter response quoting verbatim the part from the letter that illistrates the explanation mentioned in the 'explanation' part. The example array should always have the quote followed by a description of the issue. Do no create separate entries for quote and description please. \n\nThe overall is simply a sum of the four 'scores' divided by four.\n\nOne thing to keep in mind is that a score of 5 or less is to be given in any of the four criteria only in cases of letter being incomplete or text being incomprehensible. It is extremely rare for a student to not get at least a 6 on the 4 crtierias. \n\nHere is the letter topic with sample answer:\n\n${topic}\n\n${essay}`;

    try {
        const responseContent = await callOpenRouter({
            model: "microsoft/phi-3.5-mini-128k-instruct",
            response_format: { type: "json_object" },
            messages: [{"role": "user", "content": prompt}],
        });
         try {
            const jsonResponse = JSON.parse(responseContent);
            return res.json(jsonResponse);
        } catch (parseError) {
            console.error("Failed to parse OpenRouter JSON response:", parseError);
            console.error("Raw response:", responseContent);
            return res.status(500).json({ error: 'Received invalid JSON response from AI service' });
        }
    } catch (error) {
        console.error('Error processing /api/lettercriteria:', error.message);
        return res.status(500).json({ error: error.message || 'An error occurred while processing the letter criteria' });
    }
});

// --- Transcriber Endpoint (Modified) ---
app.post('/api/transcriber', upload.array('images', 3), async (req, res) => {
    const files = req.files; // Array of file objects from multer

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No image files were uploaded.' });
    }

    const filePaths = files.map(f => f.path); // Keep track of paths for cleanup

    try {
        // 1. Read files and convert to base64 data URIs
        const imagePromises = files.map(async (file) => {
            try {
                const fileBuffer = await fs.readFile(file.path);
                const base64String = fileBuffer.toString('base64');
                return `data:${file.mimetype};base64,${base64String}`;
            } catch (readError) {
                console.error(`Error reading file ${file.path}:`, readError);
                // Return null or throw, depending on how you want to handle partial failures
                return null;
            }
        });

        const imageDataUris = (await Promise.all(imagePromises)).filter(uri => uri !== null);

        if (imageDataUris.length === 0) {
            // This could happen if all file reads failed
            return res.status(500).json({ error: 'Failed to process uploaded image files.' });
        }

        // 2. Prepare payload for OpenRouter
        const fixedQuestion = "Output a transcription of this handwritten text. Do not make any grammatical corrections from your side. However, do insert any missing punctuations. Your output is going to be a single block of text of 4 or 5 paragraphs separated by a blank line (line breaks).";

        const payload = {
            model: "microsoft/phi-3.5-mini-128k-instruct", // Or appropriate vision model if needed
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: fixedQuestion },
                        // Map data URIs into the required format
                        ...imageDataUris.map(uri => ({
                            type: "image_url",
                            image_url: { url: uri }
                        }))
                    ]
                }
            ],
            max_tokens: 1500 // Adjust as needed
        };

        // 3. Call OpenRouter API
        const transcription = await callOpenRouter(payload);

        // 4. Send response
        return res.json({ transcription });

    } catch (error) {
        // Catch errors from file processing or OpenRouter call
        console.error('Error in transcriber endpoint:', error);
        return res.status(500).json({ error: error.message || 'An error occurred during transcription.' });

    } finally {
        // 5. Cleanup: Attempt to delete uploaded files regardless of success or failure
        console.log(`Cleaning up temporary files: ${filePaths.join(', ')}`);
        const cleanupPromises = filePaths.map(filePath =>
            fs.remove(filePath).catch(err => console.error(`Failed to delete temp file ${filePath}:`, err))
        );
        await Promise.all(cleanupPromises);
        console.log("Temporary file cleanup complete.");
    }
});

// Basic check route
app.get('/', (req, res) => {
    res.status(200).send('IELTS Backend API is running.');
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(`Allowed CORS origins: ${allowedOrigins.join(', ')}`);
    console.log(`Upload directory configured at: ${uploadPath}`);
});

// --- Graceful Shutdown (Optional but Recommended) ---
process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    // Perform cleanup if needed before exiting
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    // Perform cleanup if needed before exiting
    process.exit(0);
});