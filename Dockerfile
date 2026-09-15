FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY --chown=node:node package.json server.js stream.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node sdk ./sdk
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3101
USER node
LABEL org.opencontainers.image.source="https://github.com/OrendaNet/OrendaUSBCamera"
LABEL org.opencontainers.image.title="Orenda USB Camera"
LABEL org.opencontainers.image.description="Remote USB camera monitoring for OrendaBox with mobile and multi-camera views"
LABEL org.opencontainers.image.licenses="MIT"
EXPOSE 3101
CMD ["node", "server.js"]
