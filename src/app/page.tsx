'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { RoomState, Suit, Card, GameSettings } from '@/types/game';
import { PeerGameManager, PeerStatus } from '@/lib/p2p/peerManager';
import { Navbar } from '@/components/Navbar';
import { RulesModal } from '@/components/RulesModal';
import { LeaderboardModal } from '@/components/LeaderboardModal';
import { JoinOrCreateModal } from '@/components/JoinOrCreateModal';
import { GameLobby } from '@/components/GameLobby';
import { BiddingModal } from '@/components/BiddingModal';
import { TrumpSelectionModal } from '@/components/TrumpSelectionModal';
import { TrumpRevealModal } from '@/components/TrumpRevealModal';
import { GameBoard } from '@/components/GameBoard';
import { RoundEndModal } from '@/components/RoundEndModal';
import { FinalLeaderboardModal } from '@/components/FinalLeaderboardModal';

import { ROOM_INACTIVITY_TIMEOUT_MS } from '@/lib/constants';

interface SavedSession {
  roomCode: string;
  username: string;
  isHost: boolean;
}

function KaaliRaaniGame() {
  const searchParams = useSearchParams();
  const initialRoomFromUrl = searchParams.get('room') || '';

  const [manager, setManager] = useState<PeerGameManager | null>(null);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [peerStatus, setPeerStatus] = useState<PeerStatus>('disconnected');
  const [statusMessage, setStatusMessage] = useState<string>('');
  
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(false);
  const [isCardsHidden, setIsCardsHidden] = useState(false);

  const handleToggleHideCards = () => {
    setIsCardsHidden((prev) => !prev);
  };

  const managerRef = useRef<PeerGameManager | null>(null);

  useEffect(() => {
    // Check local storage for previous session with 15-min inactivity check
    if (typeof window !== 'undefined') {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const roomParam = urlParams.get('room')?.toUpperCase().trim() || '';

        const stored = localStorage.getItem('kaali_raani_session');
        if (stored) {
          const parsed: SavedSession = JSON.parse(stored);

          // If the user clicked a link with a different room code, don't auto-restore old session
          if (roomParam && roomParam !== parsed.roomCode) {
            return;
          }

          const cachedStateStr = localStorage.getItem(`kr_state_${parsed.roomCode}`);
          let cachedState: RoomState | null = null;
          if (cachedStateStr) {
            try {
              cachedState = JSON.parse(cachedStateStr);
              if (cachedState && cachedState.lastActiveAt && Date.now() - cachedState.lastActiveAt > ROOM_INACTIVITY_TIMEOUT_MS) {
                localStorage.removeItem('kaali_raani_session');
                localStorage.removeItem(`kr_state_${parsed.roomCode}`);
                return;
              }
            } catch {}
          }

          // Immediately restore ongoing game screen so user never sees the landing page or rejoin button
          if (!cachedState) {
            cachedState = {
              roomCode: parsed.roomCode,
              phase: 'lobby',
              currentRound: 0,
              totalRounds: 3,
              totalTricks: 0,
              players: [
                {
                  id: `pending-${parsed.roomCode}-${parsed.username}`,
                  username: parsed.username,
                  isHost: parsed.isHost,
                  isBot: false,
                  isReady: false,
                  isConnected: true,
                  hand: [],
                  seatIndex: 0,
                  hasPassedBid: false,
                  currentBid: 0,
                  tricksWon: 0,
                  cardPointsCollected: 0,
                  matchScore: 0,
                },
              ],
              settings: {
                totalRounds: 3,
                minBid: 70,
                bidIncrement: 5,
                maxBid: 150,
                autoFillBots: true,
                maxPlayers: 6,
              },
              highestBid: 0,
              isPartnerRevealed: false,
              currentTrick: { trickNumber: 1, leadPlayerId: '', cards: [] },
              completedTricks: [],
              roundResults: [],
              actionLogs: [
                {
                  id: `log-${Date.now()}`,
                  timestamp: Date.now(),
                  text: `Rejoined room ${parsed.roomCode}. Connecting...`,
                  type: 'system',
                },
              ],
              lastActiveAt: Date.now(),
              updatedAt: Date.now(),
            };
          }

          setRoomState(cachedState);

          // Auto-reconnect to room in the background
          const mgr = initManager();
          if (parsed.isHost) {
            mgr.initHost(parsed.roomCode, parsed.username);
          } else {
            mgr.initClient(parsed.roomCode, parsed.username);
          }
        }
      } catch {}
    }

    return () => {
      if (managerRef.current) {
        managerRef.current.destroy();
      }
    };
  }, []);

  // Periodic room inactivity check
  useEffect(() => {
    const interval = setInterval(() => {
      if (roomState && roomState.lastActiveAt) {
        if (Date.now() - roomState.lastActiveAt > ROOM_INACTIVITY_TIMEOUT_MS) {
          if (typeof window !== 'undefined') {
            try {
              localStorage.removeItem('kaali_raani_session');
              localStorage.removeItem(`kr_state_${roomState.roomCode}`);
            } catch {}
          }
          managerRef.current?.destroy();
          setManager(null);
          setRoomState(null);
          setPeerStatus('disconnected');
          setStatusMessage('Game room closed due to 15 minutes of inactivity.');
        }
      }
    }, 20000);

    return () => clearInterval(interval);
  }, [roomState]);

  const initManager = () => {
    if (managerRef.current) {
      managerRef.current.destroy();
    }
    const mgr = new PeerGameManager();
    managerRef.current = mgr;
    setManager(mgr);

    mgr.subscribeState((newState) => {
      setRoomState(newState);
    });

    mgr.subscribeStatus((status, message) => {
      setPeerStatus(status);
      if (message) setStatusMessage(message);
    });

    mgr.subscribeRoomEnded(() => {
      setRoomState(null);
      setPeerStatus('disconnected');
      setStatusMessage('The match has ended and the room has been cleared.');
    });

    return mgr;
  };

  const handleCreateRoom = async (username: string, totalRounds: number) => {
    setPeerStatus('connecting');
    setStatusMessage('');

    // Generate clean 6-character room code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'KQ';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const session: SavedSession = { roomCode: code, username, isHost: true };
    localStorage.setItem('kaali_raani_session', JSON.stringify(session));

    const mgr = initManager();
    await mgr.initHost(code, username, { totalRounds });
  };

  const handleJoinRoom = async (roomCode: string, username: string) => {
    setPeerStatus('connecting');
    setStatusMessage('Connecting to room...');

    const cleanCode = roomCode.toUpperCase().trim();
    const session: SavedSession = { roomCode: cleanCode, username, isHost: false };
    localStorage.setItem('kaali_raani_session', JSON.stringify(session));

    // Restore cached state if available, or create a provisional room state so user enters room immediately
    let initialJoinedState: RoomState | null = null;
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem(`kr_state_${cleanCode}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && (!parsed.lastActiveAt || Date.now() - parsed.lastActiveAt <= ROOM_INACTIVITY_TIMEOUT_MS)) {
            initialJoinedState = parsed;
          }
        }
      } catch {}
    }

    if (!initialJoinedState) {
      initialJoinedState = {
        roomCode: cleanCode,
        phase: 'lobby',
        currentRound: 0,
        totalRounds: 3,
        totalTricks: 0,
        players: [
          {
            id: `pending-${cleanCode}-${username}`,
            username: username,
            isHost: false,
            isBot: false,
            isReady: false,
            isConnected: true,
            hand: [],
            seatIndex: 0,
            hasPassedBid: false,
            currentBid: 0,
            tricksWon: 0,
            cardPointsCollected: 0,
            matchScore: 0,
          },
        ],
        settings: {
          totalRounds: 3,
          minBid: 70,
          bidIncrement: 5,
          maxBid: 150,
          autoFillBots: true,
          maxPlayers: 6,
        },
        highestBid: 0,
        isPartnerRevealed: false,
        currentTrick: { trickNumber: 1, leadPlayerId: '', cards: [] },
        completedTricks: [],
        roundResults: [],
        actionLogs: [
          {
            id: `log-${Date.now()}`,
            timestamp: Date.now(),
            text: `${username} joined room ${cleanCode}. Waiting for host...`,
            type: 'system',
          },
        ],
        lastActiveAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    setRoomState(initialJoinedState);

    const mgr = initManager();
    await mgr.initClient(cleanCode, username);
  };

  const handleStartGame = () => {
    manager?.startGame();
  };

  const handleNextRound = () => {
    manager?.nextRound();
  };

  const handleRestartGame = () => {
    manager?.restartGame();
  };

  const handleEndMatch = () => {
    const code = roomState?.roomCode;
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('kaali_raani_session');
        if (code) localStorage.removeItem(`kr_state_${code}`);
      } catch {}
    }
    manager?.endMatch();
    managerRef.current?.destroy();
    setManager(null);
    setRoomState(null);
    setPeerStatus('disconnected');
    setStatusMessage('Match ended. Room cleared.');
  };

  const handleAddBot = () => {
    manager?.addBot();
  };

  const handleRemoveBot = (botId: string) => {
    manager?.removeBot(botId);
  };

  const handleUpdateSettings = (settings: Partial<GameSettings>) => {
    manager?.updateSettings(settings);
  };

  const handlePlaceBid = (amount: number) => {
    manager?.placeBid(amount);
  };

  const handlePassBid = () => {
    manager?.passBid();
  };

  const handleSelectTrumpAndPartner = (trumpSuit: Suit, calledCard: Card) => {
    manager?.selectTrumpAndPartner(trumpSuit, calledCard);
  };

  const handleFinishTrumpReveal = () => {
    manager?.finishTrumpReveal();
  };

  const handlePlayCard = (cardId: string) => {
    manager?.playCard(cardId);
  };

  const handleSendChat = (text: string) => {
    manager?.sendChatMessage(text);
  };

  // Find my player in state
  const myPlayerId = manager?.myPeerId || '';
  const myUsername = manager?.username || '';
  const myPlayer =
    roomState?.players.find((p) => p.id === myPlayerId) ||
    roomState?.players.find((p) => p.username.toLowerCase() === myUsername.toLowerCase()) ||
    roomState?.players[0];

  const isHost = manager?.isHost || myPlayer?.isHost || false;
  const isDeclarer = roomState?.declarerId === myPlayer?.id;
  const declarerPlayer = roomState?.players.find((p) => p.id === roomState?.declarerId);

  return (
    <div className="relative min-h-screen bg-black text-white flex flex-col justify-between selection:bg-white selection:text-black overflow-x-hidden">
      {/* Background Wallpaper on Landing Page (pure image with no gradients) */}
      {!roomState && (
        <div
          className="fixed inset-0 z-0 bg-cover bg-center sm:bg-right bg-no-repeat pointer-events-none"
          style={{
            backgroundImage: "url('/bg-3.png')",
          }}
        />
      )}

      {/* Top Navigation */}
      <Navbar
        roomCode={roomState?.roomCode || ''}
        currentRound={roomState?.currentRound || 0}
        totalRounds={roomState?.totalRounds || 3}
        isInRoom={Boolean(roomState)}
        onOpenRules={() => setIsRulesOpen(true)}
        onOpenLeaderboard={() => setIsLeaderboardOpen(true)}
      />

      {/* Main Game Screen */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center p-2 sm:p-4 w-full">
        {/* Waiting for host banner when inside a room */}
        {roomState && peerStatus !== 'connected' && (
          <div className="w-full max-w-lg mb-3 px-4 py-2 bg-amber-950/80 border border-amber-600/60 rounded-xl text-amber-200 text-xs text-center font-mono flex items-center justify-center gap-2 shadow-lg backdrop-blur-md animate-in fade-in">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping inline-block" />
            <span>{statusMessage || 'Host is offline or away. Waiting for host to reconnect...'}</span>
          </div>
        )}

        {/* Error notification on landing page */}
        {!roomState && peerStatus === 'error' && (
          <div className="w-full max-w-lg mb-4 p-3 bg-rose-950/80 border border-rose-700 rounded-xl text-rose-300 text-xs text-center font-mono">
            {statusMessage || 'Network connection issue. Please check room code and try again.'}
          </div>
        )}

        {/* 1. LANDING: CREATE OR JOIN ROOM */}
        {!roomState ? (
          <div className="w-full flex items-center justify-center lg:justify-start lg:pl-16 xl:pl-28 2xl:pl-36">
            <JoinOrCreateModal
              initialRoomCode={initialRoomFromUrl}
              connectionError={peerStatus === 'error' ? statusMessage : undefined}
              onCreateRoom={handleCreateRoom}
              onJoinRoom={handleJoinRoom}
              onOpenRules={() => setIsRulesOpen(true)}
            />
          </div>
        ) : (
          <>
            {/* 2. LOBBY */}
            {roomState.phase === 'lobby' && (
              <GameLobby
                roomCode={roomState.roomCode}
                players={roomState.players}
                isHost={isHost}
                settings={roomState.settings}
                onStartGame={handleStartGame}
                onAddBot={handleAddBot}
                onRemoveBot={handleRemoveBot}
                onUpdateSettings={handleUpdateSettings}
              />
            )}

            {/* 3. BIDDING */}
            {roomState.phase === 'bidding' && (
              <BiddingModal
                currentBidderId={roomState.currentBidderId}
                highestBid={roomState.highestBid}
                highestBidderId={roomState.highestBidderId}
                myPlayerId={myPlayer?.id || ''}
                players={roomState.players}
                minBid={roomState.settings.minBid}
                bidIncrement={roomState.settings.bidIncrement}
                maxBid={roomState.settings.maxBid}
                myHand={myPlayer?.hand || []}
                isCardsHidden={isCardsHidden}
                onToggleHideCards={handleToggleHideCards}
                onPlaceBid={handlePlaceBid}
                onPassBid={handlePassBid}
              />
            )}

            {/* 4. TRUMP & PARTNER SELECTION */}
            {roomState.phase === 'trump_selection' && (
              <TrumpSelectionModal
                isDeclarer={isDeclarer}
                declarerUsername={declarerPlayer?.username || 'Declarer'}
                highestBid={roomState.highestBid}
                totalPlayers={roomState.players.length}
                myHand={myPlayer?.hand || []}
                isCardsHidden={isCardsHidden}
                onToggleHideCards={handleToggleHideCards}
                onConfirm={handleSelectTrumpAndPartner}
              />
            )}

            {/* 4b. TRUMP & PARTNER REVEAL ANIMATION */}
            {roomState.phase === 'trump_reveal' && roomState.trumpSuit && roomState.calledCard && (
              <TrumpRevealModal
                trumpSuit={roomState.trumpSuit}
                calledCard={roomState.calledCard}
                onComplete={handleFinishTrumpReveal}
              />
            )}

            {/* 5. PLAYING TRICKS */}
            {roomState.phase === 'playing' && (
              <GameBoard
                state={roomState}
                myPlayerId={myPlayer?.id || ''}
                isCardsHidden={isCardsHidden}
                onToggleHideCards={handleToggleHideCards}
                onPlayCard={handlePlayCard}
                onSendChat={handleSendChat}
              />
            )}

            {/* 6. ROUND END SUMMARY */}
            {roomState.phase === 'round_end' && (
              <>
                <GameBoard
                  state={roomState}
                  myPlayerId={myPlayer?.id || ''}
                  isCardsHidden={isCardsHidden}
                  onToggleHideCards={handleToggleHideCards}
                  onPlayCard={handlePlayCard}
                  onSendChat={handleSendChat}
                />
                {roomState.roundResults.length > 0 && (
                  <RoundEndModal
                    roundResult={roomState.roundResults[roomState.roundResults.length - 1]}
                    players={roomState.players}
                    currentRound={roomState.currentRound}
                    totalRounds={roomState.totalRounds}
                    isHost={isHost}
                    onNextRound={handleNextRound}
                  />
                )}
              </>
            )}

            {/* 7. MATCH END & FINAL LEADERBOARD */}
            {roomState.phase === 'match_end' && (
              <>
                <GameBoard
                  state={roomState}
                  myPlayerId={myPlayer?.id || ''}
                  isCardsHidden={isCardsHidden}
                  onToggleHideCards={handleToggleHideCards}
                  onPlayCard={handlePlayCard}
                  onSendChat={handleSendChat}
                />
                <FinalLeaderboardModal
                  players={roomState.players}
                  roundResults={roomState.roundResults}
                  totalRounds={roomState.totalRounds}
                  isHost={isHost}
                  onRestartGame={handleRestartGame}
                  onEndMatch={handleEndMatch}
                />
              </>
            )}
          </>
        )}
      </main>

      {/* Rules Modal */}
      <RulesModal isOpen={isRulesOpen} onClose={() => setIsRulesOpen(false)} />

      {/* Leaderboard Modal */}
      <LeaderboardModal
        isOpen={isLeaderboardOpen}
        onClose={() => setIsLeaderboardOpen(false)}
        players={roomState?.players || []}
        roundResults={roomState?.roundResults || []}
        currentRound={roomState?.currentRound || 1}
        totalRounds={roomState?.totalRounds || 3}
      />

      {/* Footer */}
      <footer
        className={`w-full py-3.5 px-4 text-center text-xs text-zinc-500 font-mono flex items-center justify-center ${
          roomState ? 'border-t border-zinc-900 bg-black/60 backdrop-blur-sm' : 'bg-transparent'
        }`}
      >
        <span>
          Made with ❤️ by{' '}
          <a
            href="https://github.com/parekhhyash"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white hover:underline font-bold transition-colors"
          >
            Yash Parekh
          </a>
        </span>
      </footer>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-black text-white flex items-center justify-center font-mono">
          Loading Kaali Raani...
        </div>
      }
    >
      <KaaliRaaniGame />
    </Suspense>
  );
}
