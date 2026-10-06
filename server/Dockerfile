FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SUPERPIXEL_DB=/data/logs.db

RUN adduser -D -H -u 10001 app \
    && mkdir -p /data /app \
    && chown app:app /data

WORKDIR /app
COPY app.py triage.py /app/
COPY site /app/site

USER app
EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)" || exit 1

CMD ["python", "-u", "app.py"]
