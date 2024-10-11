FROM node:18.4

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

# for some reason this file is broken when npm pulls it and copying this one manually
# downloaded from vosk release page works
# COPY vosk-linux-aarch64-0.3.38/libvosk.so node_modules/vosk/lib/linux-x86_64/libvosk.so
COPY model/ model/
COPY server.js server.js

EXPOSE 3000

CMD ["node", "server.js"]