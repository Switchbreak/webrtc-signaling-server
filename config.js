const Winston = require('winston');

module.exports = {
    LISTEN_PORT: 7000,
    MAX_PEERS: 4096,
    PING_INTERVAL: 10000,
    MAX_LOBBY_SIZE: 10,
    RATE_LIMIT: 256,
    logger: {
        level: 'info',
        format: Winston.format.combine(Winston.format.splat(), Winston.format.simple()),
        transports: [
            new Winston.transports.File({ filename: 'error.log', level: 'error' }),
            new Winston.transports.File({ filename: 'combined.log' }),
        ],
    },
}