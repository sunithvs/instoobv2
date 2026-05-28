import requests

import config


class LLMError(Exception):
    pass


class OpenAIProvider:
    def __init__(self, api_key: str, model: str):
        self.api_key = api_key
        self.model = model

    def generate(self, *, system: str, prompt: str, json_mode: bool = False) -> str:
        body: dict = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.7,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        try:
            r = requests.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=body,
                timeout=30,
            )
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
        except (requests.RequestException, KeyError, ValueError) as e:
            raise LLMError(str(e)) from e


def get_provider():
    if not config.LLM_ENABLED:
        return None
    if config.LLM_PROVIDER == "openai" and config.OPENAI_API_KEY:
        return OpenAIProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL)
    return None
