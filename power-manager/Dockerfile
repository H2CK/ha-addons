ARG BUILD_FROM
FROM $BUILD_FROM

# Install python + pip
WORKDIR /srv
RUN \
  apk add --no-cache \
    python3 py3-pip py3-yaml

# Prepare venv
RUN cd /srv && python3 -m venv venv

RUN cd /srv && source ./venv/bin/activate && \
    pip install aiomqtt && \
    pip install paho-mqtt && \
    pip install pyModbusTCP && \
    pip install schedule && \
    pip install requests

COPY src/pwrmgr.py /srv

WORKDIR /
COPY run.sh /

RUN chmod a+x /run.sh
CMD [ "/run.sh" ]