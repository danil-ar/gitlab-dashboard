ARG REGISTRY=""
FROM ${REGISTRY}python:3.12-slim

ARG pip_index_url=https://pypi.org/simple
ARG pip_trusted_host=""

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir \
    --index-url=${pip_index_url} \
    ${pip_trusted_host:+--trusted-host=${pip_trusted_host}} \
    -r requirements.txt

COPY main.py .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
