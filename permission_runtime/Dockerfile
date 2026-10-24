ARG RUNTIME_BASE=python:3.12-slim
FROM ${RUNTIME_BASE}
WORKDIR /code
COPY broker.py mcp.py client.py /code/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10002:10002
ENTRYPOINT ["python3"]
CMD ["/code/mcp.py", "/agent/broker.sock"]
