# pip install openai && python examples/client.py
import os
from openai import OpenAI

client = OpenAI(base_url=os.environ.get("PI_RESPONSES_URL", "http://127.0.0.1:8321/v1"),
                api_key=os.environ.get("PI_RESPONSES_API_KEY", "unused"))

response = client.responses.create(model="pi", input="Summarize README.md in three bullet points.")
print(response.output_text)

# Background mode with polling
import time
job = client.responses.create(model="pi", input="Write a short poem about the sea.", background=True)
while job.status in ("queued", "in_progress"):
    time.sleep(1)
    job = client.responses.retrieve(job.id)
print(job.status, job.output_text)
