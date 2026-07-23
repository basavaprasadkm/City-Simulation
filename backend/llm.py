"""
Thin wrapper around an OpenAI-compatible chat-completions endpoint.

Default provider: Groq (https://console.groq.com) — free tier, fast, no
credit card required. To switch providers, just change the env vars in
.env — no code changes needed, as long as the provider speaks the same
OpenAI-style /chat/completions schema. That includes:

  - Groq            https://api.groq.com/openai/v1/chat/completions
  - OpenRouter free models   https://openrouter.ai/api/v1/chat/completions
  - Local Ollama    http://localhost:11434/v1/chat/completions  (no key needed)

If you'd rather use Google Gemini's free tier (different schema), swap the
body of call_llm() for the Gemini REST call — everything else in this
project only depends on call_llm(system, user) returning a string.
"""
import os
import json
import time
import requests
from dotenv import load_dotenv

load_dotenv()

LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.groq.com/openai/v1/chat/completions")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")


class LLMError(Exception):
    pass


def call_llm(system: str, user: str, max_tokens: int = 2000, temperature: float = 0.9, retries: int = 2) -> str:
    """Send a system+user prompt, return the raw text response.
    Retries automatically on transient network errors and rate limits."""
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    payload = {
        "model": LLM_MODEL,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }

    last_error = None
    for attempt in range(retries + 1):
        print(f"[llm] request attempt {attempt + 1}/{retries + 1} -> {LLM_BASE_URL} (model={LLM_MODEL}, max_tokens={max_tokens})")
        try:
            resp = requests.post(LLM_BASE_URL, headers=headers, data=json.dumps(payload), timeout=40)
            if resp.status_code == 429:
                if attempt < retries:
                    wait = float(resp.headers.get("Retry-After", 20))
                    print(f"[llm] 429 rate limited -- waiting {wait}s before retry")
                    time.sleep(wait)
                    continue
                raise LLMError(
                    "Rate limit hit on the free API tier (429). This isn't a bug -- the free tier "
                    "caps how many requests/tokens you can send per minute. Wait a minute and try "
                    "again, or switch to a local Ollama model for no limits at all (see .env.example)."
                )
            resp.raise_for_status()
            data = resp.json()
            print("[llm] response received OK")
            return data["choices"][0]["message"]["content"]
        except requests.exceptions.Timeout as e:
            last_error = e
            print(f"[llm] request timed out after 40s (attempt {attempt + 1})")
            if attempt < retries:
                continue
            raise LLMError(f"LLM request timed out after {retries + 1} attempts. Check your internet connection to {LLM_BASE_URL}.")
        except requests.exceptions.RequestException as e:
            last_error = e
            print(f"[llm] request error: {e}")
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise LLMError(f"LLM request failed after {retries + 1} attempts: {e}")
        except (KeyError, IndexError) as e:
            raise LLMError(f"Unexpected LLM response shape: {e} -- raw: {resp.text[:500]}")


def parse_json_response(text: str):
    """Strip markdown fences if the model added them, then parse JSON."""
    clean = text.strip()
    if clean.startswith("```"):
        clean = clean.split("```")[1]
        if clean.startswith("json"):
            clean = clean[4:]
    return json.loads(clean.strip())


def call_llm_json(system: str, user: str, max_tokens: int = 2000, temperature: float = 0.7, json_retries: int = 2):
    """Call the LLM and parse its response as JSON. If the model returns
    malformed JSON (common with free/smaller models), ask again -- this is
    usually enough to get a clean parse without surfacing an error to the user."""
    last_error = None
    for attempt in range(json_retries + 1):
        text = call_llm(system, user, max_tokens=max_tokens, temperature=temperature)
        try:
            return parse_json_response(text)
        except (json.JSONDecodeError, IndexError) as e:
            last_error = e
            print(f"[llm] malformed JSON on attempt {attempt + 1}/{json_retries + 1}: {e}")
            continue
    raise LLMError(f"Model kept returning malformed JSON after {json_retries + 1} attempts: {last_error}")
