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

# GitLab СОГАЗа стоит за внутренним УЦ, его корни не входят в бандл certifi,
# которым httpx проверяет сертификаты. Кладем бандл в образ и указываем на него
# через GITLAB_CA_BUNDLE, вне корпоративной сети переменную можно не задавать.
COPY sogaz-ca-bundle.pem /etc/ssl/certs/sogaz-ca-bundle.pem
ENV GITLAB_CA_BUNDLE=/etc/ssl/certs/sogaz-ca-bundle.pem

COPY main.py .
COPY app/ ./app/

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
