# RabbitMQ + delayed-message-exchange plugin (spec §4, §13 — delayed/retry scheduling).
FROM rabbitmq:3.13-management-alpine

# Plugin version must match the RabbitMQ minor series (3.13.x).
ARG PLUGIN_VERSION=3.13.0
ARG PLUGIN=rabbitmq_delayed_message_exchange

RUN set -eux; \
    apk add --no-cache curl; \
    curl -fsSL -o "/opt/rabbitmq/plugins/${PLUGIN}-${PLUGIN_VERSION}.ez" \
      "https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/v${PLUGIN_VERSION}/${PLUGIN}-${PLUGIN_VERSION}.ez"; \
    rabbitmq-plugins enable --offline "${PLUGIN}"; \
    apk del curl
