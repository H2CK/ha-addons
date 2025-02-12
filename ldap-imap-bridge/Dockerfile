ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG=C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache \
    nodejs \
    npm

# Copy data for add-on
RUN mkdir -p /var/ldap-imap-adapter
RUN mkdir -p /var/ldap-imap-adapter/lib
COPY run.sh /var/ldap-imap-adapter/
RUN chmod a+x /var/ldap-imap-adapter/run.sh

COPY ldap-imap-adapter.js /var/ldap-imap-adapter/
COPY lib /var/ldap-imap-adapter/lib/
COPY package.json /var/ldap-imap-adapter/
WORKDIR /var/ldap-imap-adapter/
RUN npm install --unsafe-perm

CMD [ "/var/ldap-imap-adapter/run.sh" ]
