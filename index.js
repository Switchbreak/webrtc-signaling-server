const WebSocket = require('ws')
const Crypto = require('crypto');
const { send } = require('process');

const MESSAGE_TYPE = {
    SET_ID: 0,
    PEER_CONNECT: 1,
    PEER_DISCONNECT: 2,
    OFFER: 3,
    ANSWER: 4,
    CANDIDATE: 5,
};

const wss = new WebSocket.Server({ port: 7000 });
const peers = new Map();

wss.on('listening', () => {
    console.log('Listening on port 7000');
});

wss.on('close', (ws) => {
    console.log('Server closed');
});

wss.on('connection', (ws) => {
    console.log('Connection received');
    const id = connectPeer(ws);

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
});

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        ws.ping();
    });
}, 10000);

function connectPeer(ws) {
    const id = Crypto.randomUUID();

    var peer = {
        ws,
        id,
        name: 'Player',
        isIdSet: false,
        isHost: peers.size == 0,
    };
    peers.set(id, peer);

    setPeerId(peer, id);

    return id;
}

function disconnectPeer(id) {
    peers.delete(id);

    for (const peer of peers.values()) {
        sendPeerMessage(peer, MESSAGE_TYPE.PEER_DISCONNECT, id);
    }
}

function handlePeerMessage(fromId, packet) {
    var message = JSON.parse(packet);
    console.log('Parsed message: ', message);
    if (!validateMessage(message)) {
        console.error("Received invalid message from peer, closing connection");
        disconnectPeer(fromId);
        return;
    }

    if (message.type == MESSAGE_TYPE.PEER_CONNECT) {
        handlePeerConnection(fromId, message);
    } else {
        // Forward other message types on to the destination peer
        const dest = peers.get(message.peer_index);
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

    peers.forEach((dest, destId) => {
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

function setPeerId(peer, id) {
    peer.isIdSet = true;
    sendPeerMessage(peer, MESSAGE_TYPE.SET_ID, id);
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