ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG=C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache \
    git \
    nodejs \
    npm

WORKDIR /var
RUN git clone https://github.com/matthewgream/stiga-api.git
RUN mkdir -p /var/stiga-api/homeassistant
COPY ha-mqtt-bridge.js /var/stiga-api/homeassistant/
COPY run.sh /var/stiga-api/
RUN chmod a+x /var/stiga-api/run.sh

WORKDIR /var/stiga-api/
RUN npm install

CMD [ "/var/stiga-api/run.sh" ]