FROM node:20-slim

# ffmpeg converts the audio to MP3, python3/pip run yt-dlp
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp[default] includes the components YouTube needs (JS challenge solver)
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
