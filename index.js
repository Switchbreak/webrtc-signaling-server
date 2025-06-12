const WebSocket = require('ws');
const Crypto = require('crypto');
const rateLimit = require('ws-rate-limit')('10s', 256);

const MESSAGE_TYPE = {
    SET_ID: 0,
    PEER_CONNECT: 1,
    PEER_DISCONNECT: 2,
    OFFER: 3,
    ANSWER: 4,
    CANDIDATE: 5,
};

const MAX_PEERS = 4096;
const LOBBY_ID_LENGTH = 6;
const LOBBY_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const wss = new WebSocket.Server({ port: 7000 });
const peers = new Map();
const lobbies = new Map();

wss.on('listening', () => {
    console.log('Listening on port 7000');
});

wss.on('close', (ws) => {
    console.log('Server closed');
});

wss.on('connection', (ws, req) => {
    console.log('Connection received');
    rateLimit(ws);

    if (peers.size >= MAX_PEERS) {
        console.log('Too many peers connected');
        ws.close(1013, 'Too many peers connected');
        return;
    }

    const id = connectPeer(ws);
    const lobbyId = joinLobby(id, req);
    if (lobbyId) {
        setPeerId(id);
    }

    ws.on('message', (message) => {
        console.log('Packet received: ', message);
        handlePeerMessage(id, message);
    });
    ws.on('close', (code, reason) => {
        console.log(`Connection closed with reason: ${code} - ${reason}`);
        disconnectPeer(id);
    });
    ws.on('error', (error) => {
        console.error(error);
    });
    ws.on('limited', () => {
        console.error('Too many requests, exceeded rate limit');
    })
});

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        ws.ping();
    });
}, 10000);

function connectPeer(ws) {
    const id = Crypto.randomUUID();

    const peer = {
        ws,
        id,
        name: 'Player',
        isHost: peers.size == 0,
        lobbyId: '',
    };
    peers.set(id, peer);

    return id;
}

function disconnectPeer(id) {
    const peer = peers.get(id);
    peer.ws.close();

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

        lobby.peers.delete(peer.id);
        if (!lobby.peers.size) {
            console.log(`Lobby ${lobby.id} is empty, closing`)
            lobbies.delete(lobby.id);
        }
    }
}

function joinLobby(id, req) {
    const peer = peers.get(id);

    // Lobby ID is stored in the URL of the connection request - e.g. wss://localhost:7000/{lobby-id}
    console.log('Request URL: ', req.url);
    let lobbyId = null;
    if (req.url.length > 1) {
        lobbyId = req.url.substring(1);
    }

    if (lobbyId) {
        if (!validateLobbyId(lobbyId)) {
            console.error('Invalid lobby ID: ', lobbyId);
            peer.ws.close(1007, 'Invalid lobby ID');
            return;
        }
    } else {
        lobbyId = createLobby();
    }

    peer.lobbyId = lobbyId;
    lobbies.get(lobbyId).peers.set(id, peer);

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
    var lobbyId;
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

    console.log('Created new lobby: ', lobbyId);

    return lobbyId;
}

function handlePeerMessage(fromId, packet) {
    const from = peers.get(fromId);

    const message = JSON.parse(packet);
    console.log('Parsed message: ', message);
    if (!validateMessage(message)) {
        console.error("Received invalid message from peer, closing connection");
        from.ws.close(1007, 'Invalid message received');
        return;
    }

    if (message.type == MESSAGE_TYPE.PEER_CONNECT) {
        handlePeerConnection(fromId, message);
    } else {
        // Forward other message types on to the destination peer
        const from = peers.get(fromId);
        const dest = peers.get(message.peer_index);
        if (dest.lobbyId != from.lobbyId) {
            console.error('Destination peer is not in the same lobby');
            from.ws.close(3000, 'Destination peer is not in the same lobby');
            return;
        }

        sendPeerMessage(dest, message.type, fromId, message.data);
    }
}

function validateMessage(message) {
    if ('type' in message) {
        if (typeof message.type != "number") {
            return false;
        }
        if (!Object.values(MESSAGE_TYPE).includes(message.type)) {
            return false;
        }
    } else {
        return false;
    }

    if ('peer_index' in message) {
        if (typeof message.peer_index != "string") {
            return false;
        }
    } else {
        return false;
    }

    if (!'data' in message) {
        return false;
    }

    return true;
}

function handlePeerConnection(fromId, message) {
    const from = peers.get(fromId);
    from.name = message.data.name;

    const lobby = lobbies.get(from.lobbyId);
    console.log('Lobby: ', lobby);
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

function sendPeerMessage(peer, type, fromId, data) {
    const packet = JSON.stringify({
        'type': type,
        'peer_index': fromId,
        'data': data,
    });
    console.log('Sending packet: ', packet);
    peer.ws.send(packet);
}