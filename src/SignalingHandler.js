import { EventEmitter } from './EventEmitter.js';
import { PeerConnection } from './PeerConnection.js';
import DebugLogger from './DebugLogger.js';

/**
 * Handles WebRTC signaling messages (offers, answers, ICE candidates)
 */
export class SignalingHandler extends EventEmitter {
  constructor(mesh, connectionManager) {
    super();
    this.debug = DebugLogger.create('SignalingHandler');
    this.mesh = mesh;
    this.connectionManager = connectionManager;
  }

  async handleSignalingMessage(message) {
    const { type, data, fromPeerId, targetPeerId } = message;

    if (fromPeerId === this.mesh.peerId) return;
    if (targetPeerId && targetPeerId !== this.mesh.peerId) return;

    // Ignore cleanup messages - they are handled by the server, not as peer signaling
    if (type === 'cleanup' || type === 'cleanup-all') {
      this.debug.log('Ignoring cleanup message:', { type, fromPeerId });
      return;
    }

    // Ignore ping messages - they are for keepalive, not peer signaling
    if (type === 'ping' || type === 'pong') {
      return;
    }

    this.debug.log('Processing signaling message:', { type, fromPeerId, targetPeerId });

    switch (type) {
      case 'announce':
        this.handlePeerAnnouncement(fromPeerId);
        break;
      case 'peer-discovered':
        // Handle peer discovery messages from the signaling server
        if (data && data.peerId) {
          this.handlePeerAnnouncement(data.peerId);
        }
        break;
      case 'goodbye':
        this.handlePeerGoodbye(fromPeerId);
        break;
      case 'offer':
        await this.handleOffer(data, fromPeerId);
        break;
      case 'answer':
        await this.handleAnswer(data, fromPeerId);
        break;
      case 'ice-restart-offer':
        await this.handleIceRestartOffer(data, fromPeerId);
        break;
      case 'ice-restart-answer':
        await this.handleIceRestartAnswer(data, fromPeerId);
        break;
      case 'ice-candidate':
        await this.connectionManager.handleIceCandidate(data, fromPeerId);
        break;
      case 'connection-rejected':
        this.handleConnectionRejected(data, fromPeerId);
        break;
    }
  }

  handlePeerAnnouncement(fromPeerId) {
    // Prevent duplicate announcements - only announce if we haven't seen this peer before
    if (this.mesh.peerDiscovery.hasPeer(fromPeerId)) {
      this.debug.log(`Peer ${fromPeerId.substring(0, 8)}... already known, skipping announcement`);
      return;
    }

    this.mesh.emit('statusChanged', { type: 'info', message: `Peer ${fromPeerId.substring(0, 8)}... announced` });
    this.debug.log(`Adding discovered peer: ${fromPeerId.substring(0, 8)}... to PeerDiscovery`);
    this.debug.log(`Current peer count: ${this.connectionManager.getConnectedPeerCount()}/${this.mesh.maxPeers}`);
    this.debug.log(`All discovered peers: ${Array.from(this.mesh.peerDiscovery.discoveredPeers.keys()).map(p => p.substring(0, 8)).join(', ')}`);
    this.mesh.peerDiscovery.addDiscoveredPeer(fromPeerId);
  }

  handlePeerGoodbye(fromPeerId) {
    this.mesh.emit('statusChanged', { type: 'info', message: `Peer ${fromPeerId.substring(0, 8)}... left the network` });
    this.mesh.peerDiscovery.removeDiscoveredPeer(fromPeerId);
    this.connectionManager.disconnectPeer(fromPeerId, 'left network');
  }

  async handleOffer(offer, fromPeerId) {
    this.debug.log('Handling offer from', fromPeerId);

    // Validate offer data structure before proceeding
    if (!offer || typeof offer !== 'object') {
      this.debug.error(`Invalid offer data from ${fromPeerId}:`, offer);
      this.mesh.emit('statusChanged', { type: 'error', message: `Invalid offer data from ${fromPeerId.substring(0, 8)}...` });
      return;
    }

    if (!offer.type || offer.type !== 'offer') {
      this.debug.error(`Invalid offer type from ${fromPeerId}:`, offer.type);
      this.mesh.emit('statusChanged', { type: 'error', message: `Invalid offer type from ${fromPeerId.substring(0, 8)}...` });
      return;
    }

    if (!offer.sdp || typeof offer.sdp !== 'string' || offer.sdp.length < 10) {
      this.debug.error(`Invalid offer SDP from ${fromPeerId}:`, offer.sdp?.substring(0, 100) || 'undefined');
      this.mesh.emit('statusChanged', { type: 'error', message: `Invalid offer SDP from ${fromPeerId.substring(0, 8)}...` });
      return;
    }

    // If we already have a connection or are connecting, handle gracefully
    if (this.connectionManager.hasPeer(fromPeerId)) {
      const existingPeer = this.connectionManager.getPeer(fromPeerId);
      const existingStatus = existingPeer.getStatus();

      // If connection is already established and working, don't interfere
      if (existingStatus === 'connected') {
        this.debug.log(`Connection already established with ${fromPeerId}, ignoring duplicate offer`);
        return;
      }

      // ABSOLUTE RULE: Lexicographically larger peer ID always initiates
      // If we're receiving an offer but we should be the initiator, there's a race condition
      const weShouldInitiate = this.mesh.peerId > fromPeerId;

      if (weShouldInitiate && existingPeer.isInitiator) {
        this.debug.log(`Race condition detected! We should initiate (${this.mesh.peerId.substring(0, 8)}... > ${fromPeerId.substring(0, 8)}...) but received offer. Ignoring.`);
        return;
      } else if (!weShouldInitiate && existingPeer.isInitiator) {
        this.debug.log(`We're incorrectly initiating to ${fromPeerId.substring(0, 8)}..., backing down for their offer`);
        // Cleanup our outgoing attempt and accept the incoming offer
        if (existingStatus === 'connecting' || existingStatus === 'new') {
          this.debug.log(`Cleaning up our outgoing connection attempt to ${fromPeerId.substring(0, 8)}...`);
          this.connectionManager.cleanupRaceCondition(fromPeerId);
        } else {
          this.debug.log('Connection in progress, not cleaning up');
          return;
        }
      } else {
        this.debug.log('Already processing incoming connection from', fromPeerId);
        return;
      }
    }

    // Check if we're already attempting to connect to this peer
    if (this.connectionManager.connectionAttempts.has(fromPeerId)) {
      this.debug.log('Already attempting connection to', fromPeerId, 'accepting incoming offer');
      this.connectionManager.connectionAttempts.delete(fromPeerId);
    }

    // CRITICAL: Check capacity again right before accepting to prevent race conditions
    const currentCount = this.connectionManager.getConnectedPeerCount();
    const totalPeerCount = this.connectionManager.peers.size;
    let canAccept = this.mesh.canAcceptMorePeers();
    let evictPeerId = null;

    this.debug.log(`Capacity check for ${fromPeerId.substring(0, 8)}...: ${currentCount}/${this.mesh.maxPeers} connected, ${totalPeerCount} total peers, canAccept: ${canAccept}`);

    if (!canAccept) {
      this.debug.log(`At capacity (${currentCount}/${this.mesh.maxPeers} connected, ${totalPeerCount} total) - checking eviction and cleanup options`);

      // First try: Check if we should evict a peer for this new connection
      if (this.mesh.evictionStrategy) {
        evictPeerId = this.mesh.evictionManager.shouldEvictForPeer(fromPeerId);
        if (evictPeerId) {
          this.debug.log(`Will evict ${evictPeerId.substring(0, 8)}... for incoming connection from ${fromPeerId.substring(0, 8)}...`);
          canAccept = true; // We can accept because we'll evict
        } else {
          this.debug.log(`No suitable peer found for eviction for ${fromPeerId.substring(0, 8)}...`);
        }
      } else {
        this.debug.log(`Eviction strategy disabled - cannot evict for ${fromPeerId.substring(0, 8)}...`);
      }

      // Second try: Clean up stale peers to make room
      if (!canAccept) {
        const stalePeerCount = this.connectionManager.getStalePeerCount();
        if (stalePeerCount > 0) {
          this.debug.log(`No eviction candidate, attempting to clean up ${stalePeerCount} stale peer(s) to make room for ${fromPeerId.substring(0, 8)}...`);
          this.connectionManager.cleanupStalePeers();
          canAccept = this.mesh.canAcceptMorePeers();
          if (canAccept) {
            this.debug.log(`Successfully made room after cleanup for ${fromPeerId.substring(0, 8)}...`);
          }
        }
      }

      // Final rejection if no options worked
      if (!canAccept) {
        const reason = `max_peers_reached (${currentCount}/${this.mesh.maxPeers} connected, ${this.connectionManager.peers.size} total, no eviction candidate)`;
        this.debug.log(`Rejecting offer from ${fromPeerId.substring(0, 8)}...: ${reason}`);

        try {
          await this.mesh.sendSignalingMessage({
            type: 'connection-rejected',
            data: {
              reason: 'max_peers_reached',
              details: reason,
              currentCount,
              maxPeers: this.mesh.maxPeers
            }
          }, fromPeerId);
          this.debug.log(`Sent connection rejection to ${fromPeerId.substring(0, 8)}...`);
        } catch (error) {
          this.debug.error('Failed to send connection rejection:', error);
        }
        return;
      }
    }

    // Perform eviction if we determined one was needed
    if (evictPeerId) {
      this.mesh.emit('statusChanged', { type: 'info', message: `Evicting ${evictPeerId.substring(0, 8)}... for incoming connection from ${fromPeerId.substring(0, 8)}...` });
      await this.mesh.evictionManager.evictPeer(evictPeerId, 'incoming closer peer');
    }
    try {
      // Get current media stream if available
      const localStream = this.mesh.mediaManager.localStream;
      const hasMedia = localStream !== null;
      const options = {
        localStream,
        enableAudio: hasMedia && localStream.getAudioTracks().length > 0,
        enableVideo: hasMedia && localStream.getVideoTracks().length > 0
      };

      this.debug.log(`Creating answer connection for ${fromPeerId.substring(0, 8)}... (with media: ${hasMedia})`);

      const peerConnection = new PeerConnection(fromPeerId, false, options);

      // Set up event handlers BEFORE creating connection to catch all events
      this.connectionManager.setupPeerConnectionHandlers(peerConnection);
      this.connectionManager.peers.set(fromPeerId, peerConnection);

      await peerConnection.createConnection();

      this.debug.log(`Processing offer from ${fromPeerId.substring(0, 8)}...`, {
        type: offer.type,
        sdpLength: offer.sdp?.length || 0,
        hasAudio: offer.sdp?.includes('m=audio') || false,
        hasVideo: offer.sdp?.includes('m=video') || false
      });

      // Handle the offer using PeerConnection's method
      const answer = await peerConnection.handleOffer(offer);

      this.debug.log(`Answer created for ${fromPeerId.substring(0, 8)}...`, {
        type: answer.type,
        sdpLength: answer.sdp?.length || 0,
        hasAudio: answer.sdp?.includes('m=audio') || false,
        hasVideo: answer.sdp?.includes('m=video') || false
      });

      this.debug.log('Sending answer to', fromPeerId);

      // Send answer via signaling
      await this.mesh.sendSignalingMessage({
        type: 'answer',
        data: answer,
        timestamp: Date.now()
      }, fromPeerId);

      this.mesh.emit('statusChanged', { type: 'info', message: `Answer sent to ${fromPeerId.substring(0, 8)}...` });
      // Clear connection attempt since we're now processing the connection
      this.mesh.peerDiscovery.clearConnectionAttempt(fromPeerId);
    } catch (error) {
      this.debug.error('Failed to handle offer from', fromPeerId, ':', error);

      // If it's a state error, handle gracefully
      if (error.message.includes('state:')) {
        this.debug.log(`Offer ignored for ${fromPeerId.substring(0, 8)}... - connection state issue (likely race condition)`);
        this.mesh.emit('statusChanged', { type: 'info', message: `Offer skipped for ${fromPeerId.substring(0, 8)}... (connection state conflict)` });
      } else {
        this.mesh.emit('statusChanged', { type: 'error', message: `Failed to handle offer from ${fromPeerId.substring(0, 8)}...: ${error.message}` });
        this.connectionManager.cleanupFailedConnection(fromPeerId);
      }
    }
  }

  async handleAnswer(answer, fromPeerId) {
    this.debug.log('Handling answer from', fromPeerId);

    // Validate answer data structure before proceeding
    if (!answer || typeof answer !== 'object') {
      this.debug.error(`Invalid answer data from ${fromPeerId}:`, answer);
      this.mesh.emit('statusChanged', { type: 'error', message: `Invalid answer data from ${fromPeerId.substring(0, 8)}...` });
      return;
    }

    if (!answer.type || answer.type !== 'answer') {
      this.debug.error(`Invalid answer type from ${fromPeerId}:`, answer.type);
      this.mesh.emit('statusChanged', { type: 'error', message: `Invalid answer type from ${fromPeerId.substring(0, 8)}...` });
      return;
    }

    if (!answer.sdp || typeof answer.sdp !== 'string' || answer.sdp.length < 10) {
      this.debug.error(`Invalid answer SDP from ${fromPeerId}:`, answer.sdp?.substring(0, 100) || 'undefined');
      this.mesh.emit('statusChanged', { type: 'error', message: `Invalid answer SDP from ${fromPeerId.substring(0, 8)}...` });
      return;
    }

    const peerConnection = this.connectionManager.getPeer(fromPeerId);
    if (peerConnection) {
      try {
        await peerConnection.handleAnswer(answer);
        this.mesh.emit('statusChanged', { type: 'info', message: `Answer processed from ${fromPeerId.substring(0, 8)}...` });
      } catch (error) {
        this.debug.error('Failed to handle answer:', error);

        // If it's a state error (connection already stable), don't treat as failure
        if (error.message.includes('state:') || error.message.includes('stable')) {
          this.debug.log(`Answer ignored for ${fromPeerId.substring(0, 8)}... - connection state issue (likely race condition resolved)`);
          this.mesh.emit('statusChanged', { type: 'info', message: `Answer skipped for ${fromPeerId.substring(0, 8)}... (connection already stable)` });
        } else {
          this.mesh.emit('statusChanged', { type: 'error', message: `Failed to handle answer from ${fromPeerId.substring(0, 8)}...: ${error.message}` });
        }
      }
    } else {
      this.debug.log('No peer connection found for answer from', fromPeerId);
    }
  }

  handleConnectionRejected(data, fromPeerId) {
    this.debug.log(`Connection rejected by ${fromPeerId.substring(0, 8)}...: ${data.reason} (${data.details})`);
    this.mesh.emit('statusChanged', {
      type: 'info',
      message: `Connection rejected by ${fromPeerId.substring(0, 8)}... (${data.reason})`
    });

    // Clean up any pending connection attempt
    this.connectionManager.connectionAttempts.delete(fromPeerId);

    // Remove the peer connection if it exists and is not connected
    const peerConnection = this.connectionManager.getPeer(fromPeerId);
    if (peerConnection && peerConnection.getStatus() !== 'connected') {
      peerConnection.close();
      this.connectionManager.peers.delete(fromPeerId);
    }

    // Clear any discovery connection attempt tracking
    this.mesh.peerDiscovery.clearConnectionAttempt(fromPeerId);

    // If we have no connections, immediately try other peers more aggressively
    const connectedCount = this.connectionManager.getConnectedPeerCount();
    if (connectedCount === 0) {
      this.debug.log(`Connection rejected and peer is isolated (${connectedCount} connections) - trying alternative peers immediately`);

      // Immediately try to connect to other discovered peers
      const discoveredPeers = Array.from(this.mesh.peerDiscovery.getDiscoveredPeers());
      const availablePeers = discoveredPeers.filter(peer =>
        peer.peerId !== fromPeerId &&
                !this.connectionManager.hasPeer(peer.peerId) &&
                !this.mesh.peerDiscovery.isAttemptingConnection(peer.peerId)
      );

      if (availablePeers.length > 0) {
        // Sort by XOR distance and try the closest available peer
        const sortedByDistance = availablePeers.sort((a, b) => {
          const distA = this.mesh.peerDiscovery.calculateXorDistance(this.mesh.peerId, a.peerId);
          const distB = this.mesh.peerDiscovery.calculateXorDistance(this.mesh.peerId, b.peerId);
          return distA < distB ? -1 : 1;
        });

        const nextPeer = sortedByDistance[0];
        this.debug.log(`Immediately attempting connection to next closest peer: ${nextPeer.peerId.substring(0, 8)}...`);
        this.connectionManager.connectToPeer(nextPeer.peerId);
      }
    } else {
      // Regular mesh optimization for non-isolated peers
      setTimeout(() => {
        this.mesh.peerDiscovery.optimizeMeshConnections(this.connectionManager.peers);
      }, 1000);
    }
  }

  /**
   * Handle ICE restart offers sent over the mesh
   */
  async handleIceRestartOffer(data, fromPeerId) {
    this.debug.log(`Received ICE restart offer from ${fromPeerId.substring(0, 8)}...`);
    
    const peerConnection = this.connectionManager.peers.get(fromPeerId);
    if (!peerConnection) {
      this.debug.warn(`No peer connection found for ICE restart offer from ${fromPeerId.substring(0, 8)}...`);
      return;
    }

    try {
      await peerConnection.handleIceRestartOffer(data.offer);
      this.debug.log(`Successfully handled ICE restart offer from ${fromPeerId.substring(0, 8)}...`);
    } catch (error) {
      this.debug.error(`Failed to handle ICE restart offer from ${fromPeerId.substring(0, 8)}...:`, error);
    }
  }

  /**
   * Handle ICE restart answers sent over the mesh
   */
  async handleIceRestartAnswer(data, fromPeerId) {
    this.debug.log(`Received ICE restart answer from ${fromPeerId.substring(0, 8)}...`);
    
    const peerConnection = this.connectionManager.peers.get(fromPeerId);
    if (!peerConnection) {
      this.debug.warn(`No peer connection found for ICE restart answer from ${fromPeerId.substring(0, 8)}...`);
      return;
    }

    try {
      await peerConnection.handleIceRestartAnswer(data.answer);
      this.debug.log(`Successfully handled ICE restart answer from ${fromPeerId.substring(0, 8)}...`);
    } catch (error) {
      this.debug.error(`Failed to handle ICE restart answer from ${fromPeerId.substring(0, 8)}...:`, error);
    }
  }
}
