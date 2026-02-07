# OpenClaw Railway Deployment Guide

This guide details how to deploy OpenClaw on Railway and configure it to use different AI model providers, including OpenRouter and Anthropic.

## Prerequisites

- A [Railway](https://railway.app/) account.
- Access to the OpenClaw source code.
- API keys for your desired model provider (OpenRouter, Anthropic, etc.).
- [Railway CLI](https://docs.railway.app/guides/cli) installed (optional but recommended).

## 1. Initial Deployment

1.  **Project Setup:**
    - Push your OpenClaw code to a GitHub repository.
    - In Railway, create a new project and select "Deploy from GitHub repo".
    - Choose your OpenClaw repository.

2.  **Environment Variables (Basic):**
    - Railway will automatically detect the `Dockerfile` or `package.json`.
    - Go to the **Variables** tab in your Railway service.
    - Add the following essential variables:
      - `OPENCLAW_GATEWAY_BIND`: `lan` (Allows external connections)
      - `PORT`: `8080` (Or your preferred port, Railway provides this automatically usually)
      - `OPENCLAW_GATEWAY_TOKEN`: A secure string (e.g., `my_secret_token_2026`). You will need this to connect the UI.

3.  **Deploy:**
    - Railway should automatically trigger a deployment. Wait for it to finish.

## 2. Configuring AI Models

OpenClaw supports various providers. You configure the model using the `OPENCLAW_MODEL` environment variable.

### Option A: OpenRouter (Recommended for variety)

1.  **Get API Key:** Get your key from [openrouter.ai](https://openrouter.ai/).
2.  **Set Environment Variables:**
    - `OPENROUTER_API_KEY`: `sk-or-v1-...` (Your actual key)
    - `OPENCLAW_MODEL`: `openrouter/<provider>/<model-name>`
      - Example: `openrouter/google/gemini-3-pro-preview`
      - Example: `openrouter/anthropic/claude-3.5-sonnet`

### Option B: Anthropic (Direct)

1.  **Get API Key:** Get your key from [console.anthropic.com](https://console.anthropic.com/).
2.  **Set Environment Variables:**
    - `ANTHROPIC_API_KEY`: `sk-ant-...`
    - `OPENCLAW_MODEL`: `anthropic/<model-name>`
      - Example: `anthropic/claude-3-5-sonnet`
      - Example: `anthropic/claude-3-opus`

### Option C: OpenAI (Direct)

1.  **Get API Key:** Get your key from [platform.openai.com](https://platform.openai.com/).
2.  **Set Environment Variables:**
    - `OPENAI_API_KEY`: `sk-...`
    - `OPENCLAW_MODEL`: `openai/<model-name>`
      - Example: `openai/gpt-4o`

### Option D: Google Gemini (Direct)

1.  **Get API Key:** Get your key from Google AI Studio.
2.  **Set Environment Variables:**
    - `GOOGLE_GENERATIVE_AI_API_KEY`: `...`
    - `OPENCLAW_MODEL`: `google/<model-name>`
      - Example: `google/gemini-1.5-pro`

## 3. Connecting the Control UI

1.  **Open the App:** Click the public URL provided by Railway (e.g., `https://openclaw-production.up.railway.app`).
2.  **Enter Token:**
    - If prompted, or in **Settings**, enter the `OPENCLAW_GATEWAY_TOKEN` you set in Step 1.
3.  **Troubleshooting Pairing:**
    - If you see "Pairing Required" but cannot approve it in the UI, use the CLI.
    - Run `railway ssh` in your local terminal (linked to the project).
    - Run `node openclaw.mjs devices list` to see pending requests.
    - Run `node openclaw.mjs devices approve <REQUEST_ID>`.

## 4. Verification

1.  **Check Model:** In the Control UI, go to **Agents** or start a chat.
2.  **Verify Logs:**
    - In Railway, go to the **Deployments** tab and click "View Logs".
    - Look for the startup message indicating the active model.
    - Ensure it says precisely what you configured (e.g., `openrouter/google/gemini-3-pro-preview`) and NOT `anthropic/openrouter/...`.
