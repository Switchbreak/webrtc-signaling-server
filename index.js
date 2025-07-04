const Config = require('./config');
const WebSocket = require('ws');
const Crypto = require('crypto');
const rateLimit = require('ws-rate-limit')('10s', Config.RATE_LIMIT);
const Winston = require('winston');

const MESSAGE_TYPE = {
    SET_ID: 0,
    PEER_CONNECT: 1,
    PEER_DISCONNECT: 2,
    OFFER: 3,
    ANSWER: 4,
    CANDIDATE: 5,
};

const CLOSE_CODES = {
    GOING_AWAY: 1001,
    INVALID_PAYLOAD: 1007,
    TRY_AGAIN_LATER: 1013,
    UNAUTHORIZED: 3000,
    FORBIDDEN: 3003,
};

const LOBBY_ID_LENGTH = 6;
const LOBBY_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const logger = initLogger();

const wss = new WebSocket.Server({ port: Config.LISTEN_PORT });
const peers = new Map();
const lobbies = new Map();

wss.on('listening', () => {
    logger.info('Listening on port %d', Config.LISTEN_PORT);
});

wss.on('close', () => {
    shutdown();
});

wss.on('connection', (ws, req) => {
    logger.debug('Connection received');
    rateLimit(ws);

    if (peers.size >= Config.MAX_PEERS) {
        logger.warn('Too many peers connected');
        ws.close(CLOSE_CODES.TRY_AGAIN_LATER, 'Too many peers connected');
        return;
    }

    const id = connectPeer(ws);
    const lobbyId = joinLobby(id, req);
    if (lobbyId) {
        setPeerId(id);
    }

    ws.on('message', (message) => {
        logger.debug('Packet received: %s', message);
        handlePeerMessage(id, message);
    });
    ws.on('close', (code, reason) => {
        logger.info('Connection closed with reason: %d - %s', code, reason);
        disconnectPeer(id);
    });
    ws.on('error', (error) => {
        logger.error(error);
    });
    ws.on('limited', () => {
        logger.error('Too many requests, exceeded rate limit from IP: %s', req.socket.remoteAddress);
    })
});

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        ws.ping();
    });
}, Config.PING_INTERVAL);

process.on('SIGINT', () => {
    shutdown();
});
process.on('SIGTERM', () => {
    shutdown();
});

function initLogger() {
    const logger = Winston.createLogger(Config.logger);

    if (process.env.NODE_ENV !== 'production') {
        logger.add(new Winston.transports.Console({
            level: 'debug',
            format: Winston.format.combine(Winston.format.colorize(), Winston.format.splat(), Winston.format.simple()),
        }));
    }
    
    return logger;
}

function shutdown() {
    for(const peer of peers.values()) {
        peer.ws.close(CLOSE_CODES.GOING_AWAY, 'Server closed');
    }

    wss.close();
    logger.info('Server closed');

    process.exit();
}

function connectPeer(ws) {
    const id = Crypto.randomUUID();

    const peer = {
        ws,
        id,
        name: 'Player',
        isHost: false,
        lobbyId: '',
    };
    peers.set(id, peer);

    return id;
}

function disconnectPeer(id) {
    const peer = peers.get(id);
    if (!peer) {
        return;
    }

    leaveLobby(peer);
    peers.delete(id);

    const lobby = lobbies.get(peer.lobbyId)
    if (lobby) {
        for (const peer of lobby.peers.values()) {
            sendPeerMessage(peer, MESSAGE_TYPE.PEER_DISCONNECT, id);
        }
    }
}

function setPeerId(id) {
    const peer = peers.get(id);

    sendPeerMessage(peer, MESSAGE_TYPE.SET_ID, id, { 'lobby_id': peer.lobbyId });
}

function leaveLobby(peer) {
    if (peer.lobbyId) {
        const lobby = lobbies.get(peer.lobbyId);

        if (lobby) {
            lobby.peers.delete(peer.id);
            if (!lobby.peers.size) {
                logger.info('Lobby %s is empty, closing', lobby.id)
                lobbies.delete(lobby.id);
            }
        }
    }
}

function joinLobby(id, req) {
    const peer = peers.get(id);

    // Lobby ID is stored in the URL of the connection request - e.g. wss://localhost:7000/{lobby-id}
    logger.debug('Request URL: %s', req.url);
    let lobbyId = null;
    if (req.url.length > 1) {
        lobbyId = req.url.substring(1);
    }

    if (lobbyId) {
        if (!validateLobbyId(lobbyId)) {
            logger.error('Invalid lobby ID: %s', lobbyId);
            peer.ws.close(CLOSE_CODES.INVALID_PAYLOAD, 'Invalid lobby ID');
            return;
        }
    } else {
        lobbyId = createLobby();
        peer.isHost = true;
    }

    peer.lobbyId = lobbyId;
    const lobby = lobbies.get(lobbyId);
    if (lobby.peers.size >= Config.MAX_LOBBY_SIZE) {
        logger.error('Lobby %s is full, closing connection', lobbyId);
        peer.ws.close(CLOSE_CODES.FORBIDDEN, 'Lobby is full');
        return;
    }
    lobby.peers.set(id, peer);

    return lobbyId;
}

function validateLobbyId(lobbyId) {
    if (lobbyId.length != LOBBY_ID_LENGTH) {
        return false;
    }

    for (const char of lobbyId) {
        if (!LOBBY_ID_CHARS.includes(char)) {
            return false;
        }
    }

    if (!lobbies.has(lobbyId)) {
        return false;
    }

    return true;
}

function createLobby() {
    let lobbyId;
    do {
        lobbyId = '';
        for(let i = 0; i < LOBBY_ID_LENGTH; i++) {
            lobbyId += LOBBY_ID_CHARS[Crypto.randomInt(0, LOBBY_ID_CHARS.length)];
        }
    } while (lobbies.has(lobbyId));

    lobbies.set(lobbyId, {
        'id': lobbyId,
        'peers': new Map(),
    })

    logger.info('Created new lobby: %s', lobbyId);

    return lobbyId;
}

function handlePeerMessage(fromId, packet) {
    const from = peers.get(fromId);

    const message = JSON.parse(packet);
    logger.debug('Parsed message: ', message);
    if (!validateMessage(message)) {
        logger.error("Received invalid message from peer, closing connection");
        from.ws.close(CLOSE_CODES.INVALID_PAYLOAD, 'Invalid message received');
        return;
    }

    if (message.type == MESSAGE_TYPE.PEER_CONNECT) {
        handlePeerConnection(fromId, message);
    } else {
        // Forward other message types on to the destination peer
        const dest = peers.get(message.peer_index);
        if (!dest || dest.lobbyId != from.lobbyId) {
            logger.error('Destination peer is not in the same lobby');
            from.ws.close(CLOSE_CODES.UNAUTHORIZED, 'Destination peer is not in the same lobby');
            return;
        }

        sendPeerMessage(dest, message.type, fromId, message.data);
    }
}

function validateMessage(message) {
    if (typeof message != "object") {
        return false;
    }

    if (!('type' in message)) {
        return false;
    }
    if (typeof message.type != "number") {
        return false;
    }
    if (!Object.values(MESSAGE_TYPE).includes(message.type)) {
        return false;
    }

    if (!('peer_index' in message)) {
        return false;
    }
    if (typeof message.peer_index != "string") {
        return false;
    }

    if (!('data' in message)) {
        return false;
    }
    if (message.type == MESSAGE_TYPE.PEER_CONNECT) {
        if (typeof message.data != "object") {
            return false;
        }
        if (!('name' in message.data)) {
            return false;
        }
    }

    return true;
}

function handlePeerConnection(fromId, message) {
    const from = peers.get(fromId);

    const lobby = lobbies.get(from.lobbyId);
    logger.debug('Lobby: ', lobby);

    setPlayerName(message, lobby, from);

    lobby.peers.forEach((dest, destId) => {
        if (destId != fromId) {
            // Signal new peer to receive connection offer from existing peer
            sendPeerMessage(
                from,
                MESSAGE_TYPE.PEER_CONNECT,
                destId,
                {
                    'name': dest.name,
                    'is_host': dest.isHost,
                    'preexisting': true,
                }
            );

            // Signal each existing peer to send offer to new peer
            sendPeerMessage(dest, MESSAGE_TYPE.PEER_CONNECT, fromId, message.data);
        }
    });
}

function setPlayerName(message, lobby, from) {
    let player_name = message.data.name;
    let iterator = 1;
    while (lobby.peers.values().some((peer) => {
        return peer.id != from.id && peer.name == player_name;
    })) {
        player_name = `${message.data.name} (${iterator})`;
        iterator++;
    }
    logger.debug('Player name: %s', player_name);
    from.name = player_name;
}

function sendPeerMessage(peer, type, fromId, data) {
    const packet = JSON.stringify({
        'type': type,
        'peer_index': fromId,
        'data': data,
    });
    logger.debug('Sending packet: %s', packet);
    peer.ws.send(packet);
}