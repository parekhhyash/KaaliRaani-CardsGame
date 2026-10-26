'use client';

import { RoomState, P2PMessage, GameSettings, Suit, Card } from '@/types/game';
import { ROOM_INACTIVITY_TIMEOUT_MS, MAX_PLAYERS } from '../constants';
import {
  createInitialRoomState,
  addPlayerToRoom,
  reconnectPlayer,
  addBotPlayer,
  removeBotPlayer,
  startRound,
  placeBid,
  passBid,
  selectTrumpAndPartner,
  finishTrumpReveal,
  playCard,
  advanceTrickOrRound,
} from '../gameEngine';
import { botChooseCardToPlay, botChooseTrumpAndPartner, evaluateBotBid } from '../botAi';

export type PeerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const PEER_CONFIG = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelay',
        credential: 'openrelay',
      },
    ],
    iceCandidatePoolSize: 10,
  },
};

interface PeerConnectionMap {
  [peerId: string]: any; // DataConnection
}

export class PeerGameManager {
  private peer: any = null;
  private connections: PeerConnectionMap = {};
  private hostConnection: any = null;
  
  public myPeerId: string = '';
  public username: string = '';
  public roomCode: string = '';
  public isHost: boolean = false;
  
  public currentState: RoomState | null = null;
  private onStateChangeCallbacks: ((state: RoomState) => void)[] = [];
  private onStatusChangeCallbacks: ((status: PeerStatus, message?: string) => void)[] = [];
  private onChatMessageCallbacks: ((msg: { username: string; text: string; timestamp: number }) => void)[] = [];
  private onRoomEndedCallbacks: (() => void)[] = [];
  
  private botTimer: NodeJS.Timeout | null = null;
  private inactivityInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private clientReconnectTimer: NodeJS.Timeout | null = null;
  private trickTransitionTimer: NodeJS.Timeout | null = null;
  private revealTimer: NodeJS.Timeout | null = null;
  private unloadHandler: (() => void) | null = null;
  private isDestroyed: boolean = false;

  constructor() {
    this.startInactivityChecker();
    this.setupUnloadCleanup();
  }

  private setupUnloadCleanup() {
    if (typeof window === 'undefined') return;
    this.unloadHandler = () => {
      try {
        if (this.peer && !this.peer.destroyed) {
          this.peer.destroy();
        }
      } catch {}
    };
    window.addEventListener('beforeunload', this.unloadHandler);
    window.addEventListener('pagehide', this.unloadHandler);
  }

  private startHeartbeat() {
    if (typeof window === 'undefined') return;
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      if (this.isDestroyed) return;
      if (this.isHost) {
        for (const peerId in this.connections) {
          try {
            const conn = this.connections[peerId];
            if (conn && conn.open) {
              conn.send({ type: 'PING' });
            }
          } catch {}
        }
      } else if (this.hostConnection && this.hostConnection.open) {
        try {
          this.hostConnection.send({ type: 'PING' });
        } catch {}
      }
    }, 4000);
  }

  private startInactivityChecker() {
    if (typeof window === 'undefined') return;
    this.inactivityInterval = setInterval(() => {
      if (this.isDestroyed) return;
      if (this.currentState && this.currentState.lastActiveAt) {
        if (Date.now() - this.currentState.lastActiveAt > ROOM_INACTIVITY_TIMEOUT_MS) {
          this.handleInactivityExpiration();
        }
      }
    }, 30000);
  }

  private handleInactivityExpiration() {
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(`kr_state_${this.roomCode}`);
        localStorage.removeItem('kaali_raani_session');
      } catch {}
    }
    this.notifyStatus('disconnected', 'Room closed after 15 minutes of inactivity.');
    this.destroy();
  }

  public subscribeState(cb: (state: RoomState) => void) {
    this.onStateChangeCallbacks.push(cb);
    if (this.currentState) cb(this.currentState);
    return () => {
      this.onStateChangeCallbacks = this.onStateChangeCallbacks.filter((c) => c !== cb);
    };
  }

  public subscribeStatus(cb: (status: PeerStatus, message?: string) => void) {
    this.onStatusChangeCallbacks.push(cb);
    return () => {
      this.onStatusChangeCallbacks = this.onStatusChangeCallbacks.filter((c) => c !== cb);
    };
  }

  public subscribeChat(cb: (msg: { username: string; text: string; timestamp: number }) => void) {
    this.onChatMessageCallbacks.push(cb);
    return () => {
      this.onChatMessageCallbacks = this.onChatMessageCallbacks.filter((c) => c !== cb);
    };
  }

  public subscribeRoomEnded(cb: () => void) {
    this.onRoomEndedCallbacks.push(cb);
    return () => {
      this.onRoomEndedCallbacks = this.onRoomEndedCallbacks.filter((c) => c !== cb);
    };
  }

  private notifyStatus(status: PeerStatus, message?: string) {
    this.onStatusChangeCallbacks.forEach((cb) => cb(status, message));
  }

  private updateState(newState: RoomState) {
    this.currentState = newState;
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(`kr_state_${this.roomCode}`, JSON.stringify(newState));
      } catch {
        // quota ignore
      }
    }
    this.onStateChangeCallbacks.forEach((cb) => cb(newState));

    // If a trick just completed (all cards played and winner evaluated), pause a few seconds
    // to let all players see the last played card and the trick winner before clearing the table.
    if (
      this.isHost &&
      newState.phase === 'playing' &&
      newState.currentTrick.winnerPlayerId &&
      newState.currentTrick.cards.length >= newState.players.length
    ) {
      if (this.trickTransitionTimer) clearTimeout(this.trickTransitionTimer);
      this.trickTransitionTimer = setTimeout(() => {
        if (!this.currentState || this.currentState.phase !== 'playing') return;
        const nextState = advanceTrickOrRound(this.currentState);
        this.broadcastState(nextState);
      }, 2500); // 2.5 second pause to view completed trick
      return;
    }

    // If host, check if next turn belongs to a bot
    if (this.isHost) {
      this.checkAndExecuteBotTurn(newState);
    }
  }

  /**
   * Initializes host room
   */
  public async initHost(roomCode: string, username: string, settings?: Partial<GameSettings>, retryCount = 0): Promise<void> {
    this.roomCode = roomCode.toUpperCase().trim();
    this.username = username.trim();
    this.isHost = true;
    this.notifyStatus('connecting', 'Creating room host connection...');

    const Peer = (await import('peerjs')).default;
    const hostPeerId = `kr-${this.roomCode}-host`;
    this.myPeerId = hostPeerId;

    return new Promise((resolve, reject) => {
      try {
        this.peer = new Peer(hostPeerId, PEER_CONFIG);

        this.peer.on('open', (id: string) => {
          this.notifyStatus('connected', 'Room created successfully');
          this.startHeartbeat();
          
          // Check if restored state exists in localStorage
          let initialState: RoomState;
          const cached = typeof window !== 'undefined' ? localStorage.getItem(`kr_state_${this.roomCode}`) : null;
          if (cached) {
            try {
              const parsed = JSON.parse(cached);
              // Clean up if inactive for > 15 minutes
              if (parsed.lastActiveAt && Date.now() - parsed.lastActiveAt > ROOM_INACTIVITY_TIMEOUT_MS) {
                localStorage.removeItem(`kr_state_${this.roomCode}`);
                initialState = createInitialRoomState(this.roomCode, { id, username: this.username }, settings);
              } else {
                initialState = reconnectPlayer(parsed, this.username, id);
              }
            } catch {
              initialState = createInitialRoomState(this.roomCode, { id, username: this.username }, settings);
            }
          } else {
            initialState = createInitialRoomState(this.roomCode, { id, username: this.username }, settings);
          }

          this.updateState(initialState);
          resolve();
        });

        this.peer.on('connection', (conn: any) => {
          this.handleIncomingClient(conn);
        });

        this.peer.on('error', (err: any) => {
          console.warn('Peer host error:', err);
          if (err.type === 'unavailable-id') {
            if (retryCount < 8 && !this.isDestroyed) {
              this.notifyStatus('connecting', `Host session clearing, reconnecting (attempt ${retryCount + 1}/8)...`);
              setTimeout(async () => {
                try {
                  if (this.peer && !this.peer.destroyed) {
                    this.peer.destroy();
                  }
                  await this.initHost(roomCode, username, settings, retryCount + 1);
                  resolve();
                } catch (retryErr) {
                  reject(retryErr);
                }
              }, 1200);
            } else {
              this.notifyStatus('error', 'Host session currently busy. Please wait a few seconds and try again.');
              reject(err);
            }
          } else {
            this.notifyStatus('error', err.message || 'Host connection error');
          }
        });
      } catch (err: any) {
        this.notifyStatus('error', err.message || 'Failed to initialize PeerJS');
        reject(err);
      }
    });
  }

  /**
   * Initializes client joining a room
   */
  public async initClient(roomCode: string, username: string): Promise<void> {
    this.roomCode = roomCode.toUpperCase().trim();
    this.username = username.trim();
    this.isHost = false;
    this.notifyStatus('connecting', `Connecting to room ${this.roomCode}...`);

    const Peer = (await import('peerjs')).default;
    const cleanName = username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 8);
    const clientPeerId = `kr-${this.roomCode}-${cleanName}-${Math.random().toString(36).substring(2, 6)}`;
    this.myPeerId = clientPeerId;

    const hostPeerId = `kr-${this.roomCode}-host`;

    return new Promise((resolve) => {
      try {
        this.peer = new Peer(clientPeerId, PEER_CONFIG);

        this.peer.on('open', () => {
          this.connectToHost(hostPeerId);
          resolve();
        });

        this.peer.on('error', (err: any) => {
          console.warn('Client peer event:', err);
          if (err.type === 'peer-unavailable') {
            // Host is offline/disconnected. Keep waiting and retrying peacefully without showing a fatal error
            this.notifyStatus('connecting', 'Host is offline or away. Waiting for host to reconnect...');
            this.scheduleClientReconnect(hostPeerId);
            resolve();
            return;
          }
          if (
            err.type === 'network' ||
            err.type === 'server-error' ||
            err.type === 'socket-error' ||
            err.type === 'socket-closed'
          ) {
            this.notifyStatus('connecting', 'Reconnecting to network...');
            this.scheduleClientReconnect(hostPeerId);
            resolve();
            return;
          }
          this.notifyStatus('error', err.message || 'Client connection error');
          resolve();
        });
      } catch (err: any) {
        this.notifyStatus('error', err.message || 'Failed to initialize Peer');
        resolve();
      }
    });
  }

  private connectToHost(hostPeerId: string) {
    if (this.isDestroyed || this.isHost) return;
    if (!this.peer || this.peer.destroyed) return;

    if (this.hostConnection) {
      try {
        this.hostConnection.close();
      } catch {}
      this.hostConnection = null;
    }

    try {
      const conn = this.peer.connect(hostPeerId, {
        reliable: true,
      });

      this.hostConnection = conn;
      let hasReceivedState = false;

      conn.on('open', () => {
        if (this.clientReconnectTimer) {
          clearTimeout(this.clientReconnectTimer);
          this.clientReconnectTimer = null;
        }
        this.notifyStatus('connected', 'Connected to room host');
        this.startHeartbeat();

        const sendJoin = () => {
          if (hasReceivedState || !this.hostConnection || !this.hostConnection.open) return;
          const msg: P2PMessage = {
            type: 'JOIN_REQUEST',
            username: this.username,
            playerId: this.myPeerId,
            isHost: false,
          };
          try {
            this.hostConnection.send(msg);
          } catch (e) {
            console.warn('Failed to send JOIN_REQUEST:', e);
          }
        };

        // Send initial JOIN_REQUEST with small delay to let host SCTP stream settle
        setTimeout(sendJoin, 60);

        // If no SYNC_STATE is received within 750ms, retry sending JOIN_REQUEST up to 4 times
        let joinRetries = 0;
        const joinInterval = setInterval(() => {
          if (hasReceivedState || this.isDestroyed || !this.hostConnection?.open) {
            clearInterval(joinInterval);
            return;
          }
          joinRetries++;
          if (joinRetries > 4) {
            clearInterval(joinInterval);
            return;
          }
          sendJoin();
        }, 750);
      });

      conn.on('data', (data: any) => {
        if (data && data.type === 'SYNC_STATE') {
          hasReceivedState = true;
        }
        this.handleClientReceivedData(data);
      });

      conn.on('close', () => {
        this.notifyStatus('connecting', 'Host is offline or away. Waiting for host to reconnect...');
        this.scheduleClientReconnect(hostPeerId);
      });

      conn.on('error', (err: any) => {
        console.warn('Host connection error:', err);
        this.notifyStatus('connecting', 'Host is offline or away. Waiting for host to reconnect...');
        this.scheduleClientReconnect(hostPeerId);
      });
    } catch (err: any) {
      console.warn('connectToHost error:', err);
      this.notifyStatus('connecting', 'Host is offline or away. Waiting for host to reconnect...');
      this.scheduleClientReconnect(hostPeerId);
    }
  }

  private scheduleClientReconnect(hostPeerId: string, delayMs = 2500) {
    if (this.isDestroyed || this.isHost) return;
    if (this.clientReconnectTimer) return;

    this.clientReconnectTimer = setTimeout(() => {
      this.clientReconnectTimer = null;
      if (this.isDestroyed || this.isHost) return;
      if (this.peer && !this.peer.destroyed) {
        this.connectToHost(hostPeerId);
      }
    }, delayMs);
  }

  private handleIncomingClient(conn: any) {
    conn.on('open', () => {
      this.connections[conn.peer] = conn;
    });

    conn.on('data', (data: any) => {
      this.handleHostReceivedData(conn, data);
    });

    conn.on('close', () => {
      delete this.connections[conn.peer];
      // Mark player as disconnected in state without removing them
      if (this.currentState) {
        const updatedPlayers = this.currentState.players.map((p) =>
          p.id === conn.peer ? { ...p, isConnected: false } : p
        );
        this.broadcastState({ ...this.currentState, players: updatedPlayers });
      }
    });
  }

  /**
   * Host processes actions and broadcasts state
   */
  private handleHostReceivedData(conn: any, data: any) {
    if (!this.isHost || !this.currentState) return;

    const message = data as P2PMessage;

    switch (message.type) {
      case 'PING': {
        try {
          conn.send({ type: 'PONG' });
        } catch {}
        break;
      }

      case 'PONG': {
        // Keepalive acknowledged
        break;
      }

      case 'JOIN_REQUEST':
      case 'PLAYER_RECONNECT': {
        try {
          // If a player with the same name was already registered, close old socket if different
          const oldPlayer = this.currentState.players.find(
            (p) => p.username.trim().toLowerCase() === message.username.trim().toLowerCase()
          );
          if (oldPlayer && oldPlayer.id !== message.playerId) {
            if (this.connections[oldPlayer.id]) {
              try {
                this.connections[oldPlayer.id].close();
              } catch {}
              delete this.connections[oldPlayer.id];
            }
          }
          this.connections[message.playerId] = conn;

          const updated = addPlayerToRoom(this.currentState, {
            id: message.playerId,
            username: message.username,
          });
          this.broadcastState(updated);
        } catch (err: any) {
          const errMsg = err?.message || `A player named "${message.username}" is already connected in this room.`;
          try {
            conn.send({
              type: 'JOIN_ERROR',
              message: errMsg,
            });
            setTimeout(() => {
              try {
                conn.close();
              } catch {}
            }, 800);
          } catch (e) {
            console.warn('Failed to send JOIN_ERROR to client:', e);
          }
        }
        break;
      }

      case 'PLACE_BID': {
        const updated = placeBid(this.currentState, message.playerId, message.amount);
        this.broadcastState(updated);
        break;
      }

      case 'PASS_BID': {
        const updated = passBid(this.currentState, message.playerId);
        this.broadcastState(updated);
        break;
      }

      case 'SELECT_TRUMP_AND_PARTNER': {
        const updated = selectTrumpAndPartner(
          this.currentState,
          message.playerId,
          message.trumpSuit,
          message.calledCard
        );
        this.broadcastState(updated);
        break;
      }

      case 'PLAY_CARD': {
        const updated = playCard(this.currentState, message.playerId, message.cardId);
        this.broadcastState(updated);
        break;
      }

      case 'CHAT_MESSAGE': {
        this.broadcastMessage(message);
        this.onChatMessageCallbacks.forEach((cb) => cb(message));
        break;
      }

      default:
        break;
    }
  }

  /**
   * Client receives updates from Host
   */
  private handleClientReceivedData(data: any) {
    if (data.type === 'PING') {
      try {
        if (this.hostConnection && this.hostConnection.open) {
          this.hostConnection.send({ type: 'PONG' });
        }
      } catch {}
      return;
    } else if (data.type === 'PONG') {
      return;
    } else if (data.type === 'JOIN_ERROR') {
      if (typeof window !== 'undefined') {
        try {
          localStorage.removeItem('kaali_raani_session');
          localStorage.removeItem(`kr_state_${this.roomCode}`);
        } catch {}
      }
      this.notifyStatus('error', data.message);
      this.destroy();
      return;
    } else if (data.type === 'SYNC_STATE') {
      this.updateState(data.state);
    } else if (data.type === 'CHAT_MESSAGE') {
      this.onChatMessageCallbacks.forEach((cb) => cb(data));
    } else if (data.type === 'END_MATCH') {
      if (typeof window !== 'undefined') {
        try {
          localStorage.removeItem(`kr_state_${this.roomCode}`);
          localStorage.removeItem('kaali_raani_session');
        } catch {}
      }
      this.notifyStatus('disconnected', 'The host has ended the match. Room cleared.');
      this.onRoomEndedCallbacks.forEach((cb) => cb());
      this.destroy();
    }
  }

  /**
   * Host broadcasts updated state to all connected peers
   */
  private broadcastState(newState: RoomState) {
    this.updateState(newState);
    const msg = { type: 'SYNC_STATE', state: newState };
    for (const peerId in this.connections) {
      try {
        this.connections[peerId].send(msg);
      } catch (e) {
        console.warn('Error sending state to peer', peerId, e);
      }
    }
  }

  private broadcastMessage(msg: P2PMessage) {
    for (const peerId in this.connections) {
      try {
        this.connections[peerId].send(msg);
      } catch {}
    }
  }

  /**
   * Automated turn execution for AI bots (runs on Host machine)
   */
  private checkAndExecuteBotTurn(state: RoomState) {
    if (!this.isHost) return;
    if (this.botTimer) clearTimeout(this.botTimer);

    // 1. Check if bidding turn belongs to a Bot
    if (state.phase === 'bidding' && state.currentBidderId) {
      const activePlayer = state.players.find((p) => p.id === state.currentBidderId);
      if (activePlayer && activePlayer.isBot) {
        this.botTimer = setTimeout(() => {
          if (!this.currentState || this.currentState.phase !== 'bidding') return;
          const bidAmount = evaluateBotBid(
            activePlayer.hand,
            this.currentState.highestBid,
            this.currentState.settings.minBid
          );
          if (bidAmount !== null) {
            const updated = placeBid(this.currentState, activePlayer.id, bidAmount);
            this.broadcastState(updated);
          } else {
            const updated = passBid(this.currentState, activePlayer.id);
            this.broadcastState(updated);
          }
        }, 1200);
        return;
      }
    }

    // 2. Check if Trump & Partner selection belongs to a Bot
    if (state.phase === 'trump_selection' && state.declarerId) {
      const declarer = state.players.find((p) => p.id === state.declarerId);
      if (declarer && declarer.isBot) {
        this.botTimer = setTimeout(() => {
          if (!this.currentState || this.currentState.phase !== 'trump_selection') return;
          const { trumpSuit, calledCard } = botChooseTrumpAndPartner(declarer.hand);
          const updated = selectTrumpAndPartner(
            this.currentState,
            declarer.id,
            trumpSuit,
            calledCard
          );
          this.broadcastState(updated);
        }, 1500);
        return;
      }
    }

    // 2b. Automatically advance from trump_reveal to playing after cinematic reveal animation
    if (state.phase === 'trump_reveal') {
      if (this.isHost) {
        if (this.revealTimer) clearTimeout(this.revealTimer);
        this.revealTimer = setTimeout(() => {
          if (!this.currentState || this.currentState.phase !== 'trump_reveal') return;
          const updated = finishTrumpReveal(this.currentState);
          this.broadcastState(updated);
        }, 5300);
      }
      return;
    }

    // 3. Check if Card Play turn belongs to a Bot
    if (state.phase === 'playing' && state.currentTurnPlayerId) {
      const activePlayer = state.players.find((p) => p.id === state.currentTurnPlayerId);
      if (activePlayer && activePlayer.isBot) {
        this.botTimer = setTimeout(() => {
          if (!this.currentState || this.currentState.phase !== 'playing') return;
          const cardToPlay = botChooseCardToPlay(activePlayer, this.currentState);
          if (cardToPlay) {
            const updated = playCard(this.currentState, activePlayer.id, cardToPlay.id);
            this.broadcastState(updated);
          }
        }, 1400);
        return;
      }
    }
  }

  // --- Public Action Methods triggered by UI ---

  public startGame() {
    if (!this.isHost || !this.currentState) return;
    let state = this.currentState;

    // Must have at least 4 players to start (minimum 4, capped at 6)
    while (state.players.length < 4) {
      state = addBotPlayer(state);
    }

    const roundStarted = startRound(state, 1);
    this.broadcastState(roundStarted);
  }

  public nextRound() {
    if (!this.isHost || !this.currentState) return;
    const nextRoundNum = this.currentState.currentRound + 1;
    if (nextRoundNum <= this.currentState.totalRounds) {
      const roundStarted = startRound(this.currentState, nextRoundNum);
      this.broadcastState(roundStarted);
    }
  }

  public restartGame() {
    if (!this.isHost || !this.currentState) return;
    const resetPlayers = this.currentState.players.map((p) => ({
      ...p,
      matchScore: 0,
      tricksWon: 0,
      cardPointsCollected: 0,
      hand: [],
    }));
    const restarted = startRound({ ...this.currentState, players: resetPlayers, roundResults: [] }, 1);
    this.broadcastState(restarted);
  }

  public endMatch() {
    if (this.isHost) {
      this.broadcastMessage({ type: 'END_MATCH' });
    }
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(`kr_state_${this.roomCode}`);
        localStorage.removeItem('kaali_raani_session');
      } catch {}
    }
    this.notifyStatus('disconnected', 'Match ended. Room cleared.');
    this.onRoomEndedCallbacks.forEach((cb) => cb());
    this.destroy();
  }

  public addBot() {
    if (!this.isHost || !this.currentState) return;
    const maxAllowed = MAX_PLAYERS;
    if (this.currentState.players.length >= maxAllowed) return;
    const updated = addBotPlayer(this.currentState);
    this.broadcastState(updated);
  }

  public removeBot(botId: string) {
    if (!this.isHost || !this.currentState) return;
    const updated = removeBotPlayer(this.currentState, botId);
    this.broadcastState(updated);
  }

  public updateSettings(settings: Partial<GameSettings>) {
    if (!this.isHost || !this.currentState) return;
    const updated: RoomState = {
      ...this.currentState,
      settings: { ...this.currentState.settings, ...settings },
      totalRounds: settings.totalRounds ?? this.currentState.totalRounds,
    };
    this.broadcastState(updated);
  }

  public placeBid(amount: number) {
    if (this.isHost) {
      if (!this.currentState) return;
      const updated = placeBid(this.currentState, this.myPeerId, amount);
      this.broadcastState(updated);
    } else if (this.hostConnection) {
      this.hostConnection.send({
        type: 'PLACE_BID',
        playerId: this.myPeerId,
        amount,
      });
    }
  }

  public passBid() {
    if (this.isHost) {
      if (!this.currentState) return;
      const updated = passBid(this.currentState, this.myPeerId);
      this.broadcastState(updated);
    } else if (this.hostConnection) {
      this.hostConnection.send({
        type: 'PASS_BID',
        playerId: this.myPeerId,
      });
    }
  }

  public selectTrumpAndPartner(trumpSuit: Suit, calledCard: Card) {
    if (this.isHost) {
      if (!this.currentState) return;
      const updated = selectTrumpAndPartner(
        this.currentState,
        this.myPeerId,
        trumpSuit,
        calledCard
      );
      this.broadcastState(updated);
    } else if (this.hostConnection) {
      this.hostConnection.send({
        type: 'SELECT_TRUMP_AND_PARTNER',
        playerId: this.myPeerId,
        trumpSuit,
        calledCard,
      });
    }
  }

  public finishTrumpReveal() {
    if (!this.isHost || !this.currentState || this.currentState.phase !== 'trump_reveal') return;
    if (this.revealTimer) clearTimeout(this.revealTimer);
    const updated = finishTrumpReveal(this.currentState);
    this.broadcastState(updated);
  }

  public playCard(cardId: string) {
    if (this.isHost) {
      if (!this.currentState) return;
      const updated = playCard(this.currentState, this.myPeerId, cardId);
      this.broadcastState(updated);
    } else if (this.hostConnection) {
      this.hostConnection.send({
        type: 'PLAY_CARD',
        playerId: this.myPeerId,
        cardId,
      });
    }
  }

  public sendChatMessage(text: string) {
    const chatMsg = {
      type: 'CHAT_MESSAGE' as const,
      username: this.username,
      text: text.trim(),
      timestamp: Date.now(),
    };
    if (this.isHost) {
      this.broadcastMessage(chatMsg);
      this.onChatMessageCallbacks.forEach((cb) => cb(chatMsg));
    } else if (this.hostConnection) {
      this.hostConnection.send(chatMsg);
    }
  }

  public destroy() {
    this.isDestroyed = true;
    if (this.botTimer) clearTimeout(this.botTimer);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    if (this.trickTransitionTimer) clearTimeout(this.trickTransitionTimer);
    if (this.inactivityInterval) clearInterval(this.inactivityInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.clientReconnectTimer) {
      clearTimeout(this.clientReconnectTimer);
      this.clientReconnectTimer = null;
    }
    if (typeof window !== 'undefined' && this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      window.removeEventListener('pagehide', this.unloadHandler);
      this.unloadHandler = null;
    }
    for (const peerId in this.connections) {
      try {
        this.connections[peerId].close();
      } catch {}
    }
    this.connections = {};
    if (this.hostConnection) {
      try {
        this.hostConnection.close();
      } catch {}
      this.hostConnection = null;
    }
    try {
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
    } catch {}
  }
}
