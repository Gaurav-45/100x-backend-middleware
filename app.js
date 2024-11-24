const express = require("express");
const { OpenAI } = require("@langchain/openai");
const { PromptTemplate } = require("@langchain/core/prompts");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
require("dotenv").config();

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());

// Initialize OpenAI
const model = new OpenAI({
  temperature: 0.3,
  openAIApiKey: process.env.GPT_API_KEY,
});

// Define the categories and their corresponding Django API endpoints
const CATEGORIES = {
  "Screenshot + Research Agent": "/api/analyze/",
  "Impersonation Agent": "/api/generate/",
  "Viral Thread Generator": "/api/generate-thread/",
  "Fact-Checker Agent": "/api/fact-check/",
  "Sentiment Analyzer": "/api/analyze-tweet/",
  "Meme Creator": "/api/generate-meme/",
  Generic: "/api/process-tweet/",
};

// Enhanced prompt template for command classification
const classificationPrompt = new PromptTemplate({
  template: `Analyze the following user command and categorize it into exactly one of these categories:
    - Screenshot + Research Agent (if they want analysis of an image/screenshot)
    - Impersonation Agent (if they want to generate a response in someone's style)
    - Viral Thread Generator (if they want a thread or series of tweets)
    - Fact-Checker Agent (if they want fact-checking or verification)
    - Sentiment Analyzer (if they want emotional or sentiment analysis)
    - Meme Creator (if they want a meme response)
    - Generic (if they want explanation or context or any simple activity)

    User Command: {command}
    Original Tweet Context: {originalTweet}

    Examples:
    - "make this into a meme" → Meme Creator
    - "is this true?" → Fact-Checker Agent
    - "explain this tweet" → Generic
    - "roast this tweet" → Generic
    - "what's the sentiment here" → Sentiment Analyzer
    - "make a thread about this" → Viral Thread Generator

    Respond with only the category name, nothing else.
    `,
  inputVariables: ["command", "originalTweet"],
});

// Function to classify user command using LangChain and GPT
async function classifyCommand(command, originalTweet) {
  const formattedPrompt = await classificationPrompt.format({
    command: command,
    originalTweet: originalTweet,
  });

  const response = await model.call(formattedPrompt);
  return response.trim();
}

// Function to extract media URLs from tweet (implement based on your Twitter API)
async function extractMediaUrls(tweet) {
  // Implement based on your Twitter API integration
  // Should return an array of media URLs if present
  return tweet.media_urls || [];
}

// Function to download media from URL
async function downloadMedia(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

// Function to forward request to Django API
async function forwardToDjango(category, data) {
  const djangoBaseUrl = process.env.DJANGO_BASE_URL || "http://localhost:8000";
  const endpoint = CATEGORIES[category];

  if (!endpoint) {
    throw new Error(`Invalid category: ${category}`);
  }

  try {
    let response;
    const payload = {
      original_tweet: data.originalTweet,
      user_command: data.command,
      ...data.metadata,
    };

    switch (category) {
      case "Screenshot + Research Agent":
        const formData = new FormData();
        if (data.mediaBuffer) {
          formData.append("image", data.mediaBuffer, "media.jpg");
        }
        formData.append("tweet_text", data.originalTweet);
        response = await axios.post(`${djangoBaseUrl}${endpoint}`, formData, {
          headers: formData.getHeaders(),
        });
        break;

      case "Impersonation Agent":
        response = await axios.post(`${djangoBaseUrl}${endpoint}`, {
          ...payload,
          original_tweet: data.originalTweet,
          user_command: data.command,
        });
        break;

      case "Meme Creator":
        response = await axios.post(`${djangoBaseUrl}${endpoint}`, {
          ...payload,
          input_text: data.originalTweet,
        });
        break;

      case "Fact-Checker Agent":
        response = await axios.post(`${djangoBaseUrl}${endpoint}`, {
          ...payload,
          claim: data.originalTweet,
        });
        break;

      case "Viral Thread Generator":
        response = await axios.post(`${djangoBaseUrl}${endpoint}`, {
          ...payload,
          topic: data.originalTweet,
        });
        break;

      case "Sentiment Analyzer":
        response = await axios.post(`${djangoBaseUrl}${endpoint}`, {
          ...payload,
          tweet_text: data.originalTweet,
        });
        break;

      default: // Generic
        response = await axios.post(`${djangoBaseUrl}${endpoint}`, {
          ...payload,
          tweet: data.originalTweet,
          instructions: data.command,
        });
    }
    return response.data;
  } catch (error) {
    console.error("Error forwarding to Django:", error);
    throw error;
  }
}

// Main endpoint to handle Twitter bot mentions
app.post("/process-mention", upload.none(), async (req, res) => {
  try {
    const { userCommand, originalTweet } = req.body;

    if (!userCommand || !originalTweet) {
      return res
        .status(400)
        .json({ error: "Both user command and original tweet are required" });
    }

    // Classify the user's command
    const category = await classifyCommand(userCommand, originalTweet);
    console.log(`Command classified as: ${category}`);

    // Extract and download media if present
    let mediaBuffer = null;
    const mediaUrls = await extractMediaUrls(originalTweet);
    if (mediaUrls.length > 0) {
      mediaBuffer = await downloadMedia(mediaUrls[0]);
    }

    // Forward to appropriate Django endpoint
    const result = await forwardToDjango(category, {
      command: userCommand,
      originalTweet: originalTweet,
      mediaBuffer,
      metadata: {
        processed_at: new Date().toISOString(),
        category: category,
      },
    });

    res.json({
      success: true,
      category,
      result,
    });
  } catch (error) {
    console.error("Error processing mention:", error);
    res.status(500).json({
      error: "Error processing mention",
      details: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Something went wrong!",
    details: err.message,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Twitter bot processing service running on port ${PORT}`);
});
