import { EventEmitter } from './EventEmitter.js';
import { SignalingClient } from './SignalingClient.js';
import { PeerDiscovery } from './PeerDiscovery.js';
import { ConnectionManager } from './ConnectionManager.js';
import { SignalingHandler } from './SignalingHandler.js';
import { EvictionManager } from './EvictionManager.js';
import { MeshOptimizer } from './MeshOptimizer.js';
import { CleanupManager } from './CleanupManager.js';
import { StorageManager } from './StorageManager.js';
import { GossipManager } from './GossipManager.js';
import { MediaManager } from './MediaManager.js';
import { WebDHT } from './WebDHT.js';
import { environmentDetector } from './EnvironmentDetector.js';

export class PeerPigeonMesh extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Validate environment capabilities
        this.environmentReport = this.validateEnvironment(options);
        
        this.peerId = null;
        this.providedPeerId = options.peerId || null;
        this.signalingClient = null;
        this.peerDiscovery = null;
        
        // Configuration
        this.maxPeers = 3;
        this.minPeers = 2;
        this.autoDiscovery = true;
        this.evictionStrategy = true;
        this.xorRouting = true;
        this.enableWebDHT = options.enableWebDHT !== false; // Default to true, can be disabled by setting to false
        
        // State
        this.connected = false;
        this.polling = false; // Only WebSocket is supported
        this.signalingUrl = null;
        this.discoveredPeers = new Map();
        this.connectionMonitorInterval = null;
        
        // Initialize managers
        this.storageManager = new StorageManager(this);
        this.mediaManager = new MediaManager();
        this.connectionManager = new ConnectionManager(this);
        this.evictionManager = new EvictionManager(this, this.connectionManager);
        this.meshOptimizer = new MeshOptimizer(this, this.connectionManager, this.evictionManager);
        this.cleanupManager = new CleanupManager(this);
        this.signalingHandler = new SignalingHandler(this, this.connectionManager);
        this.gossipManager = new GossipManager(this, this.connectionManager);
        this.webDHT = null; // Will be initialized after peerId is set
        
        // Set up inter-module event forwarding
        this.setupManagerEventHandlers();
        
        // Set up unload handlers
        this.cleanupManager.setupUnloadHandlers();
        
        // Load saved signaling URL immediately
        this.storageManager.loadSignalingUrlFromStorage();
    }

    setupManagerEventHandlers() {
        // Forward events from managers to main mesh
        this.connectionManager.addEventListener('peersUpdated', () => {
            this.emit('peersUpdated');
        });
        
        // Track successful connections to reset isolation timer
        this.connectionManager.addEventListener('peerConnected', (data) => {
            if (this.peerDiscovery) {
                this.peerDiscovery.onConnectionEstablished();
            }
            this.emit('peerConnected', data);
        });

        // Handle peer disconnections and trigger keep-alive ping coordination
        this.addEventListener('peerDisconnected', (data) => {
            console.log(`Peer ${data.peerId.substring(0, 8)}... disconnected: ${data.reason}`);
            // Trigger immediate keep-alive ping check in case the disconnected peer was the designated sender
            if (this.signalingClient && this.signalingClient.connected) {
                setTimeout(() => {
                    this.signalingClient.triggerKeepAlivePingCheck();
                }, 1000); // Small delay to let peer lists update
            }
        });
        
        // Handle gossip messages
        this.gossipManager.addEventListener('messageReceived', (data) => {
            this.emit('messageReceived', data);
        });

        // Forward media events
        this.mediaManager.addEventListener('localStreamStarted', (data) => {
            this.emit('localStreamStarted', data);
        });

        this.mediaManager.addEventListener('localStreamStopped', () => {
            this.emit('localStreamStopped');
        });

        this.mediaManager.addEventListener('error', (data) => {
            this.emit('mediaError', data);
        });

        // Forward remote stream events from ConnectionManager
        this.connectionManager.addEventListener('remoteStream', (data) => {
            this.emit('remoteStream', data);
        });
    }

    validateEnvironment(options = {}) {
        const report = environmentDetector.getEnvironmentReport();
        const warnings = [];
        const errors = [];

        // Log environment info
        console.log('🔍 PeerPigeon Environment Detection:', {
            runtime: `${report.runtime.isBrowser ? 'Browser' : ''}${report.runtime.isNodeJS ? 'Node.js' : ''}${report.runtime.isWorker ? 'Worker' : ''}`,
            webrtc: report.capabilities.webrtc,
            websocket: report.capabilities.webSocket,
            browser: report.browser?.name || 'N/A'
        });

        // Check WebRTC support (required for peer connections)
        if (!report.capabilities.webrtc) {
            if (report.runtime.isBrowser) {
                errors.push('WebRTC is not supported in this browser. PeerPigeon requires WebRTC for peer-to-peer connections.');
            } else if (report.runtime.isNodeJS) {
                warnings.push('WebRTC support not detected in Node.js environment. Consider using a WebRTC library like node-webrtc.');
            }
        }

        // Check WebSocket support (required for signaling)
        if (!report.capabilities.webSocket) {
            if (report.runtime.isBrowser) {
                errors.push('WebSocket is not supported in this browser. PeerPigeon requires WebSocket for signaling.');
            } else if (report.runtime.isNodeJS) {
                warnings.push('WebSocket support not detected. Install the "ws" package for WebSocket support in Node.js.');
            }
        }

        // Check storage capabilities for persistent peer ID
        if (report.runtime.isBrowser && !report.capabilities.localStorage && !report.capabilities.sessionStorage) {
            warnings.push('No storage mechanism available. Peer ID will not persist between sessions.');
        }

        // Check crypto support for secure peer ID generation
        if (!report.capabilities.randomValues) {
            warnings.push('Crypto random values not available. Peer ID generation may be less secure.');
        }

        // Network connectivity checks
        if (report.runtime.isBrowser && !report.network.online) {
            warnings.push('Browser reports offline status. Mesh networking may not function properly.');
        }

        // Environment-specific warnings
        if (report.runtime.isBrowser) {
            // Browser-specific checks
            const browser = report.browser;
            if (browser && browser.name === 'ie') {
                errors.push('Internet Explorer is not supported. Please use a modern browser.');
            }
            
            // Check for secure context in production
            if (typeof location !== 'undefined' && location.protocol === 'http:' && location.hostname !== 'localhost') {
                warnings.push('Running on HTTP in production. Some WebRTC features may be limited. Consider using HTTPS.');
            }
        }

        // Handle errors and warnings
        if (errors.length > 0) {
            const errorMessage = 'PeerPigeon environment validation failed:\n' + errors.join('\n');
            console.error(errorMessage);
            if (!options.ignoreEnvironmentErrors) {
                throw new Error(errorMessage);
            }
        }

        if (warnings.length > 0) {
            console.warn('PeerPigeon environment warnings:\n' + warnings.join('\n'));
        }

        // Store capabilities for runtime checks
        this.capabilities = report.capabilities;
        this.runtimeInfo = report.runtime;

        return report;
    }

    async init() {
        try {
            // Use provided peer ID if valid, otherwise generate one
            if (this.providedPeerId) {
                if (this.storageManager.validatePeerId(this.providedPeerId)) {
                    this.peerId = this.providedPeerId;
                    console.log(`Using provided peer ID: ${this.peerId}`);
                } else {
                    console.warn(`Invalid peer ID provided: ${this.providedPeerId}. Must be 40-character SHA-1 hex string. Generating new one.`);
                    this.peerId = await this.storageManager.generatePeerId();
                }
            } else {
                this.peerId = await this.storageManager.generatePeerId();
            }
            
            // Initialize WebDHT now that we have a peerId (if enabled)
            if (this.enableWebDHT) {
                this.webDHT = new WebDHT(this);
                console.log('WebDHT initialized and enabled');
                
                // Setup WebDHT event handlers now that it's initialized
                this.setupWebDHTEventHandlers();
            } else {
                console.log('WebDHT disabled by configuration');
            }
            
            // Load signaling URL from query params or storage
            const savedUrl = this.storageManager.loadSignalingUrlFromQuery();
            if (savedUrl) {
                this.signalingUrl = savedUrl;
            }
            
            this.signalingClient = new SignalingClient(this.peerId, this.maxPeers, this);
            this.setupSignalingHandlers();
            
            this.peerDiscovery = new PeerDiscovery(this.peerId, {
                autoDiscovery: this.autoDiscovery,
                evictionStrategy: this.evictionStrategy,
                xorRouting: this.xorRouting,
                minPeers: this.minPeers,
                maxPeers: this.maxPeers
            });
            this.setupDiscoveryHandlers();
            
            this.emit('statusChanged', { type: 'initialized', peerId: this.peerId });
        } catch (error) {
            console.error('Failed to initialize mesh:', error);
            this.emit('statusChanged', { type: 'error', message: `Initialization failed: ${error.message}` });
            throw error;
        }
    }

    setupSignalingHandlers() {
        this.signalingClient.addEventListener('connected', () => {
            this.connected = true;
            this.polling = false;
            this.peerDiscovery.start();
            
            // Start periodic health monitoring
            this.startConnectionMonitoring();
            
            this.emit('statusChanged', { type: 'connected' });
        });

        this.signalingClient.addEventListener('disconnected', () => {
            this.connected = false;
            this.polling = false;
            this.peerDiscovery.stop();
            this.connectionManager.disconnectAllPeers();
            this.stopConnectionMonitoring();
            this.emit('statusChanged', { type: 'disconnected' });
        });

        this.signalingClient.addEventListener('signalingMessage', (message) => {
            this.signalingHandler.handleSignalingMessage(message);
        });

        this.signalingClient.addEventListener('statusChanged', (data) => {
            this.emit('statusChanged', data);
        });
    }

    setupDiscoveryHandlers() {
        this.peerDiscovery.addEventListener('peerDiscovered', (data) => {
            this.emit('peerDiscovered', data);
        });

        this.peerDiscovery.addEventListener('connectToPeer', (data) => {
            console.log(`PeerDiscovery requested connection to: ${data.peerId.substring(0, 8)}...`);
            this.connectionManager.connectToPeer(data.peerId);
        });

        this.peerDiscovery.addEventListener('evictPeer', (data) => {
            this.evictionManager.evictPeer(data.peerId, data.reason);
        });

        this.peerDiscovery.addEventListener('optimizeMesh', () => {
            this.peerDiscovery.optimizeMeshConnections(this.connectionManager.peers);
        });

        this.peerDiscovery.addEventListener('optimizeConnections', (data) => {
            this.meshOptimizer.handleOptimizeConnections(data.unconnectedPeers);
        });

        this.peerDiscovery.addEventListener('peersUpdated', (data) => {
            this.emit('statusChanged', { type: 'info', message: `Cleaned up ${data.removedCount} stale peer(s)` });
            this.emit('peersUpdated');
        });

        // Handle capacity checks
        this.peerDiscovery.addEventListener('checkCapacity', () => {
            const canAccept = this.connectionManager.canAcceptMorePeers();
            const currentConnectionCount = this.connectionManager.getConnectedPeerCount();
            console.log(`Capacity check: ${canAccept} (${currentConnectionCount}/${this.maxPeers} peers)`);
            this.peerDiscovery._canAcceptMorePeers = canAccept;
            this.peerDiscovery._currentConnectionCount = currentConnectionCount;
        });

        // Handle eviction checks
        this.peerDiscovery.addEventListener('checkEviction', (data) => {
            const evictPeerId = this.evictionManager.shouldEvictForPeer(data.newPeerId);
            console.log(`Eviction check for ${data.newPeerId.substring(0, 8)}...: ${evictPeerId ? evictPeerId.substring(0, 8) + '...' : 'none'}`);
            this.peerDiscovery._shouldEvictForPeer = evictPeerId;
        });
    }

    async connect(signalingUrl) {
        this.signalingUrl = signalingUrl;
        this.storageManager.saveSignalingUrlToStorage(signalingUrl);
        this.polling = false; // Only WebSocket is supported
        // Don't emit connecting here - SignalingClient will handle it with more detail

        try {
            await this.signalingClient.connect(signalingUrl);
        } catch (error) {
            console.error('Connection failed:', error);
            this.polling = false;
            this.emit('statusChanged', { type: 'error', message: `Connection failed: ${error.message}` });
            throw error;
        }
    }

    disconnect() {
        if (this.connected) {
            this.cleanupManager.sendGoodbyeMessage();
        }

        this.connected = false;
        this.polling = false;
        
        // Stop connection monitoring
        this.stopConnectionMonitoring();
        
        if (this.signalingClient) {
            this.signalingClient.disconnect();
        }
        
        if (this.peerDiscovery) {
            this.peerDiscovery.stop();
        }

        this.connectionManager.disconnectAllPeers();
        this.connectionManager.cleanup();
        
        // Cleanup WebDHT
        if (this.webDHT) {
            this.webDHT.cleanup();
        }
        this.evictionManager.cleanup();
        this.cleanupManager.cleanup();
        this.gossipManager.cleanup();

        this.emit('statusChanged', { type: 'disconnected' });
    }

    // Configuration methods
    setMaxPeers(maxPeers) {
        this.maxPeers = Math.max(1, Math.min(50, maxPeers));
        
        if (this.connectionManager.peers.size > this.maxPeers) {
            this.evictionManager.disconnectExcessPeers();
        }
        
        return this.maxPeers;
    }

    setMinPeers(minPeers) {
        this.minPeers = Math.max(0, Math.min(49, minPeers));
        
        // If we're below minimum and auto-discovery is enabled, trigger optimization
        if (this.connectionManager.getConnectedPeerCount() < this.minPeers && this.autoDiscovery && this.connected) {
            this.peerDiscovery.optimizeMeshConnections(this.connectionManager.peers);
        }
        
        return this.minPeers;
    }

    setXorRouting(enabled) {
        this.xorRouting = enabled;
        this.emit('statusChanged', { type: 'setting', setting: 'xorRouting', value: enabled });
        
        // If XOR routing is disabled, we might need to adjust our connection strategy
        if (!enabled && this.evictionStrategy) {
            this.emit('statusChanged', { type: 'warning', message: 'XOR routing disabled - eviction strategy effectiveness reduced' });
        }
    }

    setAutoDiscovery(enabled) {
        this.autoDiscovery = enabled;
        this.emit('statusChanged', { type: 'setting', setting: 'autoDiscovery', value: enabled });
    }

    setEvictionStrategy(enabled) {
        this.evictionStrategy = enabled;
        this.emit('statusChanged', { type: 'setting', setting: 'evictionStrategy', value: enabled });
    }

    // Status and information methods
    getStatus() {
        const connectedCount = this.connectionManager.getConnectedPeerCount();
        const totalCount = this.connectionManager.peers.size;
        return {
            peerId: this.peerId,
            connected: this.connected,
            polling: false, // Only WebSocket is supported
            connectedCount: connectedCount,
            totalPeerCount: totalCount, // Include total count for debugging
            minPeers: this.minPeers,
            maxPeers: this.maxPeers,
            discoveredCount: this.discoveredPeers.size,
            autoDiscovery: this.autoDiscovery,
            evictionStrategy: this.evictionStrategy,
            xorRouting: this.xorRouting
        };
    }

    getPeers() {
        return this.connectionManager.getPeers();
    }

    getPeerStatus(peerConnection) {
        return peerConnection.getStatus();
    }

    getDiscoveredPeers() {
        if (!this.peerDiscovery) {
            return [];
        }
        const discoveredPeers = this.peerDiscovery.getDiscoveredPeers();
        
        // Enrich with connection state from the actual peer connections
        return discoveredPeers.map(peer => {
            const peerConnection = this.connectionManager.getPeer(peer.peerId);
            let isConnected = false;
            
            if (peerConnection) {
                const status = peerConnection.getStatus();
                // Consider peer connected if WebRTC connection is established
                isConnected = status === 'connected' || status === 'channel-connecting';
            }
            
            return {
                ...peer,
                isConnected
            };
        });
    }

    /**
     * Send a direct message to a specific peer via gossip routing
     * @param {string} targetPeerId - The destination peer's ID
     * @param {string|object} content - The message content
     * @returns {string|null} The message ID if sent, or null on error
     */
    sendDirectMessage(targetPeerId, content) {
        if (!targetPeerId || typeof targetPeerId !== 'string') {
            console.error('Invalid targetPeerId for direct message');
            return null;
        }
        return this.gossipManager.sendDirectMessage(targetPeerId, content);
    }

    /**
     * Send a broadcast (gossip) message to all peers
     * @param {string|object} content - The message content
     * @returns {string|null} The message ID if sent, or null on error
     */
    sendMessage(content) {
        // For clarity, this is a broadcast/gossip message
        return this.gossipManager.broadcastMessage(content, 'chat');
    }

    // Helper methods for backward compatibility
    canAcceptMorePeers() {
        return this.connectionManager.canAcceptMorePeers();
    }

    getConnectedPeerCount() {
        return this.connectionManager.getConnectedPeerCount();
    }

    // Expose peers Map for backward compatibility
    get peers() {
        return this.connectionManager.peers;
    }

    // Get peer status method for UI compatibility
    getPeerStatus(peer) {
        if (!peer) return 'unknown';
        return peer.getStatus ? peer.getStatus() : 'unknown';
    }

    // Get connected peer IDs as array for UI compatibility
    getConnectedPeerIds() {
        return this.connectionManager.getPeers()
            .filter(peer => peer.status === 'connected')
            .map(peer => peer.peerId);
    }

    // Advanced methods
    async cleanupStaleSignalingData() {
        return this.cleanupManager.cleanupStaleSignalingData();
    }

    forceConnectToAllPeers() {
        return this.meshOptimizer.forceConnectToAllPeers();
    }

    // Debugging and maintenance methods
    forceCleanupInvalidPeers() {
        console.log('Force cleaning up peers not in connected state...');
        return this.connectionManager.forceCleanupInvalidPeers();
    }

    cleanupStalePeers() {
        console.log('Manually cleaning up stale peers...');
        return this.connectionManager.cleanupStalePeers();
    }

    getPeerStateSummary() {
        return this.connectionManager.getPeerStateSummary();
    }

    debugConnectivity() {
        return this.meshOptimizer.debugConnectivity();
    }

    // Connection monitoring methods
    startConnectionMonitoring() {
        // Monitor connection health every 2 minutes
        if (this.connectionMonitorInterval) {
            clearInterval(this.connectionMonitorInterval);
        }
        
        // Environment-aware timer
        const intervalCallback = () => {
            if (this.signalingClient) {
                const stats = this.signalingClient.getConnectionStats();
                console.log('Connection monitoring:', stats);
                
                // Force health check if connection seems problematic
                if (stats.connected && stats.lastPingTime && stats.lastPongTime) {
                    const timeSinceLastPong = Date.now() - stats.lastPongTime;
                    if (timeSinceLastPong > 60000) { // 1 minute without pong
                        console.warn('Connection may be unhealthy, forcing health check');
                        this.signalingClient.forceHealthCheck();
                    }
                }
                
                // Emit connection status for UI
                this.emit('connectionStats', stats);
            }
        };

        if (environmentDetector.isBrowser) {
            this.connectionMonitorInterval = window.setInterval(intervalCallback, 120000);
        } else {
            this.connectionMonitorInterval = setInterval(intervalCallback, 120000);
        }
        
        console.log('Started connection monitoring');
    }

    stopConnectionMonitoring() {
        if (this.connectionMonitorInterval) {
            clearInterval(this.connectionMonitorInterval);
            this.connectionMonitorInterval = null;
            console.log('Stopped connection monitoring');
        }
    }

    // Media management methods
    async initializeMedia() {
        return await this.mediaManager.init();
    }

    async startMedia(options = {}) {
        const { video = false, audio = false, deviceIds = {} } = options;
        
        try {
            const stream = await this.mediaManager.startLocalStream({ video, audio, deviceIds });
            
            // Update all existing peer connections with the new stream
            const connections = this.connectionManager.getAllConnections();
            for (const connection of connections) {
                await connection.setLocalStream(stream);
            }
            
            return stream;
        } catch (error) {
            console.error('Failed to start media:', error);
            throw error;
        }
    }

    async stopMedia() {
        this.mediaManager.stopLocalStream();
        
        // Update all existing peer connections to remove the stream
        const connections = this.connectionManager.getAllConnections();
        for (const connection of connections) {
            await connection.setLocalStream(null);
        }
    }

    toggleVideo() {
        return this.mediaManager.toggleVideo();
    }

    toggleAudio() {
        return this.mediaManager.toggleAudio();
    }

    getMediaState() {
        return this.mediaManager.getMediaState();
    }

    getMediaDevices() {
        return this.mediaManager.devices;
    }

    async enumerateMediaDevices() {
        return await this.mediaManager.enumerateDevices();
    }

    getLocalStream() {
        return this.mediaManager.localStream;
    }

    // Get remote streams from all connected peers
    getRemoteStreams() {
        const streams = new Map();
        const connections = this.connectionManager.getAllConnections();
        
        for (const connection of connections) {
            const remoteStream = connection.getRemoteStream();
            if (remoteStream) {
                streams.set(connection.peerId, remoteStream);
            }
        }
        
        return streams;
    }

    // Static utility methods
    static validatePeerId(peerId) {
        return typeof peerId === 'string' && /^[a-fA-F0-9]{40}$/.test(peerId);
    }

    static async generatePeerId() {
        const array = new Uint8Array(20);
        crypto.getRandomValues(array);
        return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    // WebDHT methods - Distributed Hash Table
    /**
     * Store a key-value pair in the distributed hash table
     * @param {string} key - The key to store
     * @param {any} value - The value to store
     * @param {object} options - Storage options (ttl, etc.)
     * @returns {Promise<boolean>} True if stored successfully
     */
    async dhtPut(key, value, options = {}) {
        if (!this.enableWebDHT) {
            throw new Error('WebDHT is disabled. Enable it by setting enableWebDHT: true in constructor options.');
        }
        if (!this.webDHT) {
            throw new Error('WebDHT not initialized');
        }
        return this.webDHT.put(key, value, options);
    }

    /**
     * Retrieve a value from the distributed hash table
     * @param {string} key - The key to retrieve
     * @param {object} options - Retrieval options (subscribe, etc.)
     * @returns {Promise<any>} The stored value or null if not found
     */
    async dhtGet(key, options = {}) {
        if (!this.enableWebDHT) {
            throw new Error('WebDHT is disabled. Enable it by setting enableWebDHT: true in constructor options.');
        }
        if (!this.webDHT) {
            throw new Error('WebDHT not initialized');
        }
        return this.webDHT.get(key, options);
    }

    /**
     * Subscribe to changes for a key in the DHT
     * @param {string} key - The key to subscribe to
     * @returns {Promise<any>} The current value
     */
    async dhtSubscribe(key) {
        if (!this.enableWebDHT) {
            throw new Error('WebDHT is disabled. Enable it by setting enableWebDHT: true in constructor options.');
        }
        if (!this.webDHT) {
            throw new Error('WebDHT not initialized');
        }
        return this.webDHT.subscribe(key);
    }

    /**
     * Unsubscribe from changes for a key in the DHT
     * @param {string} key - The key to unsubscribe from
     */
    async dhtUnsubscribe(key) {
        if (!this.enableWebDHT) {
            throw new Error('WebDHT is disabled. Enable it by setting enableWebDHT: true in constructor options.');
        }
        if (!this.webDHT) {
            throw new Error('WebDHT not initialized');
        }
        return this.webDHT.unsubscribe(key);
    }

    /**
     * Update a key's value and notify subscribers
     * @param {string} key - The key to update
     * @param {any} newValue - The new value
     * @param {object} options - Update options
     * @returns {Promise<boolean>} True if updated successfully
     */
    async dhtUpdate(key, newValue, options = {}) {
        if (!this.enableWebDHT) {
            throw new Error('WebDHT is disabled. Enable it by setting enableWebDHT: true in constructor options.');
        }
        if (!this.webDHT) {
            throw new Error('WebDHT not initialized');
        }
        return this.webDHT.update(key, newValue, options);
    }

    /**
     * Get DHT statistics
     * @returns {object} DHT statistics
     */
    getDHTStats() {
        if (!this.enableWebDHT) {
            return { error: 'WebDHT is disabled. Enable it by setting enableWebDHT: true in constructor options.' };
        }
        if (!this.webDHT) {
            return { error: 'WebDHT not initialized' };
        }
        return this.webDHT.getStats();
    }

    /**
     * Check if WebDHT is enabled
     * @returns {boolean} True if WebDHT is enabled
     */
    isDHTEnabled() {
        return this.enableWebDHT;
    }

    /**
     * Setup WebDHT event handlers
     */
    setupWebDHTEventHandlers() {
        // Only set up if webDHT exists
        if (this.webDHT) {
            this.webDHT.addEventListener('valueChanged', (data) => {
                this.emit('dhtValueChanged', data);
            });
        }
    }

    /**
     * Connect to a specific peer by ID
     */
    connectToPeer(peerId) {
        if (!peerId || typeof peerId !== 'string') {
            throw new Error('Valid peer ID is required');
        }
        
        if (peerId === this.peerId) {
            throw new Error('Cannot connect to yourself');
        }
        
        return this.connectionManager.connectToPeer(peerId);
    }

    /**
     * Get the current environment report
     * @returns {object} Complete environment detection report
     */
    getEnvironmentReport() {
        return this.environmentReport;
    }

    /**
     * Get runtime capabilities
     * @returns {object} Capabilities detected during initialization
     */
    getCapabilities() {
        return this.capabilities;
    }

    /**
     * Get runtime information
     * @returns {object} Runtime environment information
     */
    getRuntimeInfo() {
        return this.runtimeInfo;
    }

    /**
     * Check if a specific feature is supported
     * @param {string} feature - The feature to check (e.g., 'webrtc', 'websocket', 'localstorage')
     * @returns {boolean} True if the feature is supported
     */
    hasFeature(feature) {
        return environmentDetector.hasFeature(feature);
    }

    /**
     * Get environment-specific recommendations
     * @returns {object} Recommendations based on current environment
     */
    getEnvironmentRecommendations() {
        const recommendations = [];
        const report = this.environmentReport;

        if (report.runtime.isBrowser) {
            if (!report.network.online) {
                recommendations.push({
                    type: 'warning',
                    message: 'Browser is offline. Enable network connectivity for mesh functionality.'
                });
            }

            if (typeof location !== 'undefined' && location.protocol === 'http:' && location.hostname !== 'localhost') {
                recommendations.push({
                    type: 'security',
                    message: 'Consider using HTTPS for better WebRTC compatibility and security.'
                });
            }

            if (report.browser && report.browser.name === 'safari') {
                recommendations.push({
                    type: 'compatibility',
                    message: 'Safari has some WebRTC limitations. Test thoroughly for production use.'
                });
            }
        }

        if (report.runtime.isNodeJS) {
            if (!report.capabilities.webSocket) {
                recommendations.push({
                    type: 'dependency',
                    message: 'Install the "ws" package for WebSocket support: npm install ws'
                });
            }

            if (!report.capabilities.webrtc) {
                recommendations.push({
                    type: 'dependency',
                    message: 'Install "node-webrtc" or similar for WebRTC support in Node.js: npm install node-webrtc'
                });
            }
        }

        if (!report.capabilities.localStorage && !report.capabilities.sessionStorage) {
            recommendations.push({
                type: 'feature',
                message: 'No persistent storage available. Peer ID will change on restart.'
            });
        }

        return {
            environment: report.runtime,
            recommendations
        };
    }
}