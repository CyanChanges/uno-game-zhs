const nameInput = document.getElementById('name');
const lobbyIdInput = document.getElementById('lobby-id');
const joinButton = document.getElementById('join');
const playersList = document.getElementById('players');
const readyButton = document.getElementById('ready');
const lobbyDiv = document.getElementById('lobby');
const gameDiv = document.getElementById('game');
const opponentHandsDiv = document.getElementById('opponent-hands');
const playerHandDiv = document.getElementById('player-hand');
const discardPileDiv = document.getElementById('discard-pile');
const drawCardButton = document.getElementById('draw-card');

const turnIndicator = document.getElementById('turn-indicator');
const turnText = document.getElementById('turn-text');
const wildColorPicker = document.getElementById('wild-color-picker');
const colorOptions = document.getElementById('color-options');
const lobbyInfo = document.getElementById('lobby-info');
const currentLobbyId = document.getElementById('current-lobby-id');
const inviteAIBtn = document.getElementById('invite-ai');
const reactionTextInput = document.getElementById('reaction-text-input');
const reactionSendBtn = document.getElementById('reaction-send-btn');
const reactionEmojis = document.getElementById('reaction-emojis');
const cardLayoutToggle = document.getElementById('card-layout-toggle');

let myId;
let ws;
let currentTurn = -1;
let players = [];
let pendingWildCard = null;
let selectedCards = [];
let isSelectingMultiple = false;
let myHand = [];
let myLobbyId = null;

// Add these elements to the existing DOM references
const joinFormContainer = document.createElement('div');
joinFormContainer.id = 'join-form-container';

let isDisconnected = false;
let disconnectToastTimeout = null;
let countdownInterval = null;
let actionQueue = [];
let refreshErrorCount = 0;
let refreshErrorTime = 0;
let justReconnected = false;

function encodeUGC(content) {
    const tempEl = document.createElement('div');
    tempEl.textContent = content;
    return tempEl.innerHTML;
}

// Modal dialog helpers — replaces native alert/confirm
const modalOverlay = document.getElementById('modal-overlay');
const modalMessage = document.getElementById('modal-message');
const modalOkBtn = document.getElementById('modal-ok-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');

function showAlert(msg) {
    console.debug('showAlert', msg)

    return new Promise(resolve => {
        modalCancelBtn.style.display = 'none';
        modalMessage.textContent = msg;
        modalOkBtn.textContent = '确定';
        modalOverlay.classList.remove('hidden');
        modalOverlay.style.display = 'flex';

        function cleanup() {
            modalOverlay.classList.add('hidden');
            modalOverlay.style.display = '';
            modalOkBtn.removeEventListener('click', onOk);
            resolve();
        }
        function onOk() { cleanup(); }
        modalOkBtn.addEventListener('click', onOk);
    });
}

function showConfirm(msg) {
    console.debug('showConfirm', msg)

    return new Promise(resolve => {
        modalCancelBtn.style.display = '';
        modalMessage.textContent = msg;
        modalOkBtn.textContent = '确定';
        modalOverlay.classList.remove('hidden');
        modalOverlay.style.display = 'flex';

        function cleanup(result) {
            modalOverlay.classList.add('hidden');
            modalOverlay.style.display = '';
            modalOkBtn.removeEventListener('click', onOk);
            modalCancelBtn.removeEventListener('click', onCancel);
            resolve(result);
        }
        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }
        modalOkBtn.addEventListener('click', onOk);
        modalCancelBtn.addEventListener('click', onCancel);
    });
}

let connecting = false;
let currentWs = null;
function connect() {
    if (connecting && ws && ws.readyState !== WebSocket.CLOSED) return;
    connecting = true;
    const wsUrl = new URL('/ws', location.href)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const newWs = new WebSocket(wsUrl);
    currentWs = newWs;
    ws = newWs;

    newWs.onopen = () => {
        if (newWs !== currentWs) return;
        connecting = false;
        console.log('Connected to server');
        isDisconnected = false;
        const btn = document.getElementById('dev-disconnect-btn');
        if (btn) btn.textContent = '断开';
        const savedId = localStorage.getItem('unoPlayerId');
        console.log(`[client] onopen savedId=${savedId?.slice(0,8)} actionQueue=${actionQueue.length}`);
        if (savedId) {
            justReconnected = true;
            sendMessage({ action: 'reconnect', playerId: savedId });
        } else if (!localStorage.getItem('unoLeftLobby')) {
            const savedName = localStorage.getItem('unoPlayerName');
            const savedLobbyId = localStorage.getItem('unoLobbyId');
            if (savedName && savedLobbyId) {
                const msg = { action: 'join', name: savedName, lobbyId: savedLobbyId };
                if (savedId) msg.playerId = savedId;
                console.log(`[client] onopen fallback join name=${savedName}`);
                sendMessage(msg);
            }
            hideDisconnectedToast();
        } else {
            localStorage.removeItem('unoLeftLobby');
            nameInput.value = localStorage.getItem('unoPlayerName') || '';
            lobbyIdInput.value = localStorage.getItem('unoLobbyId') || '';
            hideDisconnectedToast();
        }
    };

    newWs.onmessage = async (event) => {
        const message = JSON.parse(event.data);

        if (message.action === 'init') {
            myId = message.id;
            console.log('[init] myId =', myId);
            if (message.reconnectLost) {
                console.log('[init] reconnect lost, showing join form');
                localStorage.removeItem('unoPlayerId');
                localStorage.removeItem('unoInLobby');
                localStorage.removeItem('unoInGame');
                localStorage.setItem('unoLeftLobby', 'true');
                myLobbyId = null;
                resetGameState();
            } else if (!localStorage.getItem('unoPlayerId')) {
                localStorage.setItem('unoPlayerId', myId);
            }
            if (message.dev) setupDevPanel();
            hideDisconnectedToast();
            return;
        }

        if (message.action === 'error') {
            if (message.message.includes('刷新页面')) {
                const now = Date.now();
                if (now - refreshErrorTime > 10000) {
                    refreshErrorCount = 0;
                }
                refreshErrorTime = now;
                refreshErrorCount++;
                if (refreshErrorCount >= 3) {
                    const reset = await showConfirm('多次重连失败，是否重置连接状态？（重置不会清除玩家名称和大厅 ID）');
                    if (reset) {
                        localStorage.removeItem('unoInLobby');
                        localStorage.removeItem('unoInGame');
                        localStorage.removeItem('unoPlayerId');
                    }
                    refreshErrorCount = 0;
                    nameInput.disabled = false;
                    lobbyIdInput.disabled = false;
                    joinButton.disabled = false;
                    return;
                }
            }
            showAlert(message.message).then(() => {
                if (message.message.includes('刷新页面')) {
                    localStorage.removeItem('unoInLobby');
                    localStorage.removeItem('unoInGame');
                    localStorage.removeItem('unoPlayerId');
                    nameInput.disabled = false;
                    lobbyIdInput.disabled = false;
                    joinButton.disabled = false;
                    return;
                }
                nameInput.disabled = false;
                lobbyIdInput.disabled = false;
                joinButton.disabled = false;
            });
            return;
        }

        if (message.action === 'players') {
            console.log(`[client] players received, flushing actionQueue (was ${actionQueue.length})`);
            hideDisconnectedToast();
            flushQueue();
            players = message.players;
            currentTurn = message.turn;
            myLobbyId = message.lobbyId;
            localStorage.setItem('unoPlayerId', myId);
            localStorage.setItem('unoInLobby', '1');
            console.log('[players] myId =', myId, 'players =', players.map(p => ({ id: p.id, name: p.name })));
            updatePlayers(message.players, message.turn);
            updateTurnIndicator();
            showLobbyInfo(message.lobbyId);
        }

        if (message.action === 'start') {
            console.log(`[client] start received, flushing actionQueue (was ${actionQueue.length})`);
            hideDisconnectedToast();
            flushQueue();
            myId = message.id;
            localStorage.setItem('unoPlayerId', myId);
            console.log('[start] myId =', myId, 'players =', message.players.map(p => ({ id: p.id, name: p.name })), 'turn =', message.turn);
            lobbyDiv.style.display = 'none';
            gameDiv.style.display = 'block';
            players = message.players;
            currentTurn = message.turn;
            myHand = message.hand;
            updatePlayers(message.players, message.turn);
            updateHand(message.hand);
            applyCardLayout();
            updateDiscardPile(message.discardPile);
            updateTurnIndicator();
        }

        if (message.action === 'update') {
            console.log(`[client] update received, flushing actionQueue (was ${actionQueue.length})`);
            hideDisconnectedToast();
            flushQueue();
            console.log('[update] myId =', myId, 'turn =', message.turn, 'players =', message.players.map(p => ({ id: p.id, name: p.name })), 'current =', message.players[message.turn] ? message.players[message.turn].id : null);
            players = message.players;
            currentTurn = message.turn;
            myHand = message.hand;
            updatePlayers(message.players, message.turn);
            updateHand(message.hand);
            applyCardLayout();
            updateDiscardPile(message.discardPile);
            updateTurnIndicator();
        }

        if (message.action === 'win') {
            showGameOver(message.winner);
        }

        if (message.action === 'game_aborted') {
            showGameAborted();
        }

        if (message.action === 'dev_state_export') {
            console.log('[dev_state_export]', JSON.stringify(message.log, null, 2));
            showAlert('状态日志已输出到控制台');
            return;
        }

        if (message.action === 'reaction') {
            showReaction(message.playerId, message.type, message.content);
        }
    };

    newWs.onclose = (event) => {
        if (newWs !== currentWs) return;
        connecting = false;
        console.log(`[client] ws.onclose code=${event.code} reason=${event.reason}`);
        isDisconnected = true;
        showDisconnectedToast('connecting');
        if (event.code !== 1000) {
            setTimeout(connect, 1300);
        }
    };

    newWs.onerror = (err) => {
        if (newWs !== currentWs) return;
        console.error('WebSocket error:', err);
    };
}

function canSendMessage() {
    return ws && ws.readyState === WebSocket.OPEN;
}

function flushQueue() {
    if (justReconnected) {
        justReconnected = false;
        console.log(`[client] flushQueue sending ${actionQueue.length} queued actions`);
    }
    while (actionQueue.length > 0) {
        const msg = actionQueue.shift();
        // Skip ready on reconnect: server state is already current,
        // sending a stale ready would toggle the state incorrectly
        if (msg.action === 'ready') {
            console.log(`[client] flush SKIPPING stale ready`);
            continue;
        }
        console.log(`[client] flush sending action=${msg.action}`);
        if (canSendMessage()) {
            ws.send(JSON.stringify(msg));
        }
    }
}

function sendMessage(message) {
    if (canSendMessage()) {
        ws.send(JSON.stringify(message));
        return true;
    }
    console.log(`[client] QUEUE action=${message.action}`);
    actionQueue.push(message);
    isDisconnected = true;
    showDisconnectedToast('action');
    return false;
}

let lastReadyText = '';
function updateReadyButton() {
    if (!readyButton) return;
    readyButton.disabled = false;
    const me = players.find(p => p.id === myId);
    const text = me && me.ready ? '取消准备' : '准备';
    if (text === lastReadyText) return;
    lastReadyText = text;
    console.log(`[client] updateReadyButton myId=${myId?.slice(0,8)} found=${!!me} ready=${me?.ready} text=${text}`);
    readyButton.textContent = text;
}

function updateTurnIndicator() {
    if (currentTurn === -1 || !players.length) {
        turnText.textContent = '等待游戏开始...';
        turnIndicator.classList.remove('my-turn');
        document.body.classList.add('player-action-disabled');
        return;
    }

    const currentPlayer = players[currentTurn];
    const isMyTurn = currentPlayer && currentPlayer.id === myId;

    console.log('[turn] myId =', myId, 'currentPlayer.id =', currentPlayer ? currentPlayer.id : null, 'isMyTurn =', isMyTurn);

    // `textContent` is safe
    if (isMyTurn) {
        turnText.textContent = 'YOU';
        turnIndicator.classList.add('my-turn');
        document.body.classList.remove('player-action-disabled');
    } else {
        turnText.textContent = `${currentPlayer ? currentPlayer.name : '-'}的回合`;
        turnIndicator.classList.remove('my-turn');
        document.body.classList.add('player-action-disabled');
    }
}

function showLobbyInfo(lobbyId) {
    if (lobbyId) {
        currentLobbyId.textContent = lobbyId;
        readyButton.style.display = 'block';

        // Find the creator and update the lobby info
        const creator = players.find(p => p.isCreator);
        const lobbyInfoTitle = document.querySelector('#lobby-info h3');
        if (creator) {
            lobbyInfoTitle.innerHTML = `大厅：<span id="current-lobby-id">${encodeUGC(lobbyId)}</span><br><small style="font-size: 0.8em; opacity: 0.8;">由 ${encodeUGC(creator.name)} 创建 👑</small>`;
            // Re-add the click functionality to the new span
            const newLobbyIdSpan = document.getElementById('current-lobby-id');
            newLobbyIdSpan.style.cursor = 'pointer';
            newLobbyIdSpan.title = 'Click to copy lobby ID';
            newLobbyIdSpan.addEventListener('click', copyLobbyId);
        } else {
            lobbyInfoTitle.innerHTML = `大厅：<span id="current-lobby-id">${encodeUGC(lobbyId)}</span>`;
        }

        lobbyInfo.style.display = 'block';
        hideJoinForm();

        localStorage.setItem('unoLobbyId', lobbyId);
        localStorage.setItem('unoPlayerName', nameInput.value);
    }
}

function attemptRejoin() {
    const savedLobbyId = localStorage.getItem('unoLobbyId');
    const savedPlayerName = localStorage.getItem('unoPlayerName');

    if (savedLobbyId && savedPlayerName) {
        lobbyIdInput.value = savedLobbyId;
        nameInput.value = savedPlayerName;
    }
}

function resetGameState() {
    localStorage.removeItem('unoInLobby');
    localStorage.removeItem('unoInGame');
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    // Reset to lobby
    lobbyDiv.style.display = 'block';
    gameDiv.style.display = 'none';

    requestAnimationFrame(() => {

        nameInput.value = (localStorage.getItem('unoPlayerName') || '').trim();
        lobbyIdInput.value = localStorage.getItem('unoLobbyId') || '';
        nameInput.disabled = false;
        joinButton.disabled = false;
        lobbyIdInput.disabled = false;

        // Clear game state
        myId = null;
        currentTurn = -1;
        players = [];
        pendingWildCard = null;
        selectedCards = [];
        isSelectingMultiple = false;
        myHand = [];
        myLobbyId = null;

        // Hide wild color picker and lobby info
        wildColorPicker.style.display = 'none';
        hideLobbyInfo();
        readyButton.style.display = 'none';
        if (inviteAIBtn) inviteAIBtn.style.display = 'none';

        // Clear players list
        playersList.innerHTML = '';

        // Reset turn indicator
        turnText.textContent = 'Waiting for game to start...';
        turnIndicator.classList.remove('my-turn');

        // // Clear localStorage
        // localStorage.removeItem('unoLobbyId');
        // localStorage.removeItem('unoPlayerName');

        // fix all problem
        location.reload()
    })
}

function updatePlayers(players, turn) {
    opponentHandsDiv.innerHTML = '';
    playersList.innerHTML = '';
    for (let i = 0; i < players.length; i++) {
        const player = players[i];
        const playerDiv = document.createElement('div');
        playerDiv.classList.add('player');
        if (i === turn) {
            playerDiv.classList.add('active');
        }

        if (player.uno) {
            playerDiv.classList.add('uno');
        }

        // Add creator styling to opponent display too
        if (player.isCreator) {
            playerDiv.classList.add('creator');
        }

        if (player.isAI) {
            playerDiv.classList.add('ai');
        }

        if (player.disconnected) {
            playerDiv.classList.add('disconnected');
        }

        let displayText = player.name;
        if (player.isCreator) {
            displayText += ' 👑';
        }
        if (player.isAI) {
            displayText += ' 🤖';
        }
        if (player.disconnected && player.reconnectDeadline) {
            const remaining = Math.max(0, Math.ceil((player.reconnectDeadline - Date.now()) / 1000));
            displayText += ` · 重连中 ${remaining}s`;
        }

        // `textContent` is safe
        if (player.cardCount !== undefined && player.id !== myId) {
            playerDiv.textContent = `${displayText}（${player.cardCount} 张牌）`;
        } else {
            playerDiv.textContent = displayText;
        }

        playerDiv.dataset.playerId = player.id;
        if (player.id !== myId) {
            opponentHandsDiv.appendChild(playerDiv);
        }

        const li = document.createElement('li');
        li.classList.add('player-row');
        if (player.isCreator) li.classList.add('creator');
        if (player.isAI) li.classList.add('ai');
        if (player.disconnected) li.classList.add('disconnected');

        const nameSpan = document.createElement('span');
        nameSpan.classList.add('player-name');
        let nameText = player.name;
        if (player.isCreator) nameText += ' 👑';
        if (player.isAI) nameText += ' 🤖';
        if (player.ready) nameText += '（已准备）';
        if (player.disconnected && player.reconnectDeadline) {
            const remaining = Math.max(0, Math.ceil((player.reconnectDeadline - Date.now()) / 1000));
            nameText += ` · 重连中 ${remaining}s`;
        }
        nameSpan.textContent = nameText;
        if (i === turn) nameSpan.style.fontWeight = 'bold';
        li.appendChild(nameSpan);

        // Ready button for unready AI players (only visible to creator)
        const me = players.find(p => p.id === myId);
        if (player.isAI && me && me.isCreator) {
            const actionsDiv = document.createElement('span');
            actionsDiv.classList.add('ai-actions');

            const readyAiBtn = document.createElement('button');
            readyAiBtn.textContent = player.ready ? '取消准备' : '准备';
            readyAiBtn.classList.add('ready-ai-btn');
            readyAiBtn.addEventListener('click', () => {
                sendMessage({ action: 'ai_ready', playerId: player.id });
            });
            actionsDiv.appendChild(readyAiBtn);

            const kickAiBtn = document.createElement('button');
            kickAiBtn.textContent = '踢出';
            kickAiBtn.classList.add('kick-ai-btn');
            kickAiBtn.addEventListener('click', () => {
                sendMessage({ action: 'remove_ai', playerId: player.id });
            });
            actionsDiv.appendChild(kickAiBtn);

            li.appendChild(actionsDiv);
        }

        // Transfer creator button for non-AI non-creator players (visible to creator)
        if (me && me.isCreator && !player.isAI && !player.isCreator && !player.disconnected && player.id !== myId) {
            const transferBtn = document.createElement('button');
            transferBtn.textContent = '转让房主';
            transferBtn.classList.add('transfer-creator-btn');
            transferBtn.addEventListener('click', () => {
                sendMessage({ action: 'transfer_creator', playerId: player.id });
            });
            li.appendChild(transferBtn);
        }

        playersList.appendChild(li);
    }

    // Show/hide invite AI button
    const me = players.find(p => p.id === myId);
    if (inviteAIBtn) {
        inviteAIBtn.style.display = (me && me.isCreator) ? '' : 'none';
    }
    updateReadyButton();

    const hasDeadline = players.some(p => p.disconnected && p.reconnectDeadline);
    if (hasDeadline && !countdownInterval) {
        countdownInterval = setInterval(() => updatePlayers(players, turn), 1000);
    } else if (!hasDeadline && countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
}

function updateHand(hand) {
    const cardControls = playerHandDiv.querySelector('#card-controls');
    playerHandDiv.innerHTML = '';

    for (let i = 0; i < hand.length; i++) {
        const card = hand[i];
        const cardDiv = createCard(card);

        // Add card index for identification
        cardDiv.dataset.cardIndex = i;

        // Check if card is selected
        if (selectedCards.some(selected => selected.index === i)) {
            cardDiv.classList.add('selected');
        }

        cardDiv.addEventListener('click', () => handleCardClick(card, i, hand));
        playerHandDiv.appendChild(cardDiv);
    }

    // Add play selected cards button if multiple cards are selected (below the hand)
    if (selectedCards.length > 1) {
        const playButton = document.createElement('button');
        playButton.textContent = `出 ${selectedCards.length} 张牌`;
        playButton.classList.add('play-multiple-btn');
        playButton.addEventListener('click', playSelectedCards);
        playerHandDiv.appendChild(playButton);

        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消选择';
        cancelButton.classList.add('cancel-selection-btn');
        cancelButton.addEventListener('click', clearSelection);
        playerHandDiv.appendChild(cancelButton);
    }

    if (cardControls) playerHandDiv.appendChild(cardControls);
}

function handleCardClick(card, cardIndex, hand) {
    // If wild color picker is open and this card is not wild, dismiss picker
    if (wildColorPicker.style.display !== 'none' && card.type !== 'wild' && card.type !== 'wild4') {
        hideWildColorPicker();
    }

    // Check if we're selecting multiple cards
    if (isSelectingMultiple) {
        toggleCardSelection(card, cardIndex, hand);
    } else {
        // Check if this card can be played with others of the same type
        const sameTypeCards = hand.filter((c, i) =>
            c.type === card.type &&
            c.type !== 'wild' &&
            c.type !== 'wild4' &&
            i !== cardIndex
        );

        // if (sameTypeCards.length > 0) {
        //     // Ask user if they want to play multiple cards
        //     if (confirm(`你有 ${sameTypeCards.length + 1} 张 "${card.type}" 类型的牌是否要选择多张牌出牌？`)) {
        //         startMultipleSelection(card, cardIndex);
        //         return;
        //     }
        // }

        // Single card play
        if (card.type === 'wild' || card.type === 'wild4') {
            showWildColorPicker(card);
        } else {
            sendMessage({ action: 'play', card: card });
        }
    }
}

function startMultipleSelection(card, cardIndex) {
    isSelectingMultiple = true;
    selectedCards = [{ card, index: cardIndex }];
    updateHand(getCurrentHand());
}

function toggleCardSelection(card, cardIndex, hand) {
    const existingIndex = selectedCards.findIndex(selected => selected.index === cardIndex);

    if (existingIndex >= 0) {
        // Remove from selection
        selectedCards.splice(existingIndex, 1);
    } else {
        // Add to selection if same type as first selected card
        if (selectedCards.length === 0 || selectedCards[0].card.type === card.type) {
            selectedCards.push({ card, index: cardIndex });
        } else {
            showAlert('只能选择相同类型的牌！');
            return;
        }
    }

    // If no cards selected, exit multiple selection mode
    if (selectedCards.length === 0) {
        isSelectingMultiple = false;
    }

    updateHand(hand);
}

function playSelectedCards() {
    if (selectedCards.length === 0) return;

    const firstCard = selectedCards[0].card;
    if (firstCard.type === 'wild' || firstCard.type === 'wild4') {
        // For wild cards, we need to pick a color first
        pendingWildCard = selectedCards.map(s => s.card);
        wildColorPicker.style.display = 'block';
    } else {
        // Send multiple cards to server
        sendMessage({
            action: 'play_multiple',
            cards: selectedCards.map(s => s.card),
            indices: selectedCards.map(s => s.index)
        });
        clearSelection();
    }
}

function clearSelection() {
    selectedCards = [];
    isSelectingMultiple = false;
    hideWildColorPicker();
    updateHand(getCurrentHand());
}

function getCurrentHand() {
    return myHand;
}

function showWildColorPicker(card) {
    pendingWildCard = card;
    wildColorPicker.style.display = 'block';
}

function hideWildColorPicker() {
    wildColorPicker.style.display = 'none';
    pendingWildCard = null;
}

function updateDiscardPile(discardPile) {
    discardPileDiv.innerHTML = '';
    const card = discardPile[discardPile.length - 1];
    const cardDiv = createCard(card);
    discardPileDiv.appendChild(cardDiv);
}

function createCard(card) {
    const cardDiv = document.createElement('div');
    cardDiv.classList.add('card');

    // Set data attributes for CSS styling
    cardDiv.setAttribute('data-color', card.color || 'black');
    cardDiv.setAttribute('data-type', card.type);

    // Create card content structure
    const cardContent = document.createElement('div');
    cardContent.classList.add('card-content');

    // Determine card display values
    let cornerNumber, cornerSymbol, centerContent;

    if (card.type === 'wild') {
        cornerNumber = 'W';
        cornerSymbol = '★';
        centerContent = 'W';
    } else if (card.type === 'wild4') {
        cornerNumber = '+4';
        cornerSymbol = '★';
        centerContent = '+4';
    } else if (card.type === 'draw2') {
        cornerNumber = '+2';
        cornerSymbol = '2';
        centerContent = '+2';
    } else if (card.type === 'skip') {
        cornerNumber = 'Ø';
        cornerSymbol = 'Ø';
        centerContent = 'Ø';
    } else if (card.type === 'reverse') {
        cornerNumber = '⇄';
        cornerSymbol = '⇄';
        centerContent = '⇄';
    } else {
        cornerNumber = card.type.toUpperCase();
        cornerSymbol = card.type.toUpperCase();
        centerContent = card.type.toUpperCase();
    }

    // Create top-left corner
    const topLeftCorner = document.createElement('div');
    topLeftCorner.classList.add('card-corner', 'top-left');

    const topLeftNumber = document.createElement('div');
    topLeftNumber.classList.add('card-corner-number');
    topLeftNumber.textContent = cornerNumber;

    topLeftCorner.appendChild(topLeftNumber);

    // Create bottom-right corner
    const bottomRightCorner = document.createElement('div');
    bottomRightCorner.classList.add('card-corner', 'bottom-right');

    const bottomRightNumber = document.createElement('div');
    bottomRightNumber.classList.add('card-corner-number');
    bottomRightNumber.textContent = cornerNumber;

    bottomRightCorner.appendChild(bottomRightNumber);

    // Create center ellipse
    const cardCenter = document.createElement('div');
    cardCenter.classList.add('card-center');

    const cardCenterContent = document.createElement('div');
    cardCenterContent.classList.add('card-center-content');

    const centerElement = document.createElement('div');
    centerElement.classList.add('card-center-number');
    centerElement.textContent = centerContent;

    cardCenterContent.appendChild(centerElement);
    cardCenter.appendChild(cardCenterContent);

    // Assemble the card
    cardContent.appendChild(topLeftCorner);
    cardContent.appendChild(bottomRightCorner);
    cardContent.appendChild(cardCenter);
    cardDiv.appendChild(cardContent);

    return cardDiv;
}

// Update the color picker to handle multiple wild cards
colorOptions.addEventListener('click', (e) => {
    if (e.target.classList.contains('color-option')) {
        const color = e.target.dataset.color;
        if (pendingWildCard) {
            if (Array.isArray(pendingWildCard)) {
                // Multiple wild cards
                sendMessage({
                    action: 'play_multiple',
                    cards: pendingWildCard.map(card => ({ ...card, color: color })),
                    indices: selectedCards.map(s => s.index)
                });
                clearSelection();
            } else {
                // Single wild card
                sendMessage({ action: 'play', card: { ...pendingWildCard, color: color } });
            }
            hideWildColorPicker();
        }
    }
});

document.getElementById('cancel-wild-btn').addEventListener('click', hideWildColorPicker);

joinButton.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const lobbyId = lobbyIdInput.value.trim().toUpperCase();

    if (!name) {
        await showAlert('请输入你的名称');
        return;
    }

    if (name.length < 2) {
        await showAlert('名称至少需要 2 个字符');
        return;
    }

    if (name.length > 20) {
        await showAlert('名称不能超过 20 个字符');
        return;
    }

    // Disable form to prevent multiple submissions
    nameInput.disabled = true;
    lobbyIdInput.disabled = true;
    joinButton.disabled = true;

    const savedId = localStorage.getItem('unoPlayerId');
    const message = { action: 'join', name: name };
    if (lobbyId) message.lobbyId = lobbyId;
    if (savedId) message.playerId = savedId;
    // Save immediately so auto-reconnect can find these even if WS closes
    // before the first players/start message arrives
    localStorage.setItem('unoPlayerName', name);
    if (lobbyId) localStorage.setItem('unoLobbyId', lobbyId);
    sendMessage(message);
});

if (inviteAIBtn) {
    inviteAIBtn.addEventListener('click', () => {
        sendMessage({ action: 'add_ai' });
    });
}

readyButton.addEventListener('click', () => {
    if (readyButton.disabled) {
        console.log(`[client] ready click ignored (disabled)`);
        return;
    }
    readyButton.disabled = true;
    readyButton.textContent = '...';
    console.log(`[client] ready click, sending, isDisconnected=${isDisconnected}`);
    sendMessage({ action: 'ready' });
});

drawCardButton.addEventListener('click', () => {
    sendMessage({ action: 'draw' });
});

const surrenderBtn = document.getElementById('surrender-btn');
if (surrenderBtn) {
    surrenderBtn.addEventListener('click', async () => {
        const confirmed = await showConfirm('认输后仅可使用观战模式加入当前对局, 确定要认输吗？');
        if (confirmed) {
            sendMessage({ action: 'surrender' });
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    connect();
    attemptRejoin();

    // Create form container and move elements
    const nameDiv = nameInput.parentNode;
    const lobbyDiv = lobbyIdInput.parentNode;

    joinFormContainer.appendChild(nameDiv);
    joinFormContainer.appendChild(lobbyDiv);
    joinFormContainer.appendChild(joinButton);

    // Insert before players list
    const playersUl = document.getElementById('players');
    playersUl.parentNode.insertBefore(joinFormContainer, playersUl);

    // Add click-to-copy functionality to lobby ID
    const lobbyIdSpan = document.getElementById('current-lobby-id');
    if (lobbyIdSpan) {
        lobbyIdSpan.style.cursor = 'pointer';
        lobbyIdSpan.title = 'Click to copy lobby ID';
        lobbyIdSpan.addEventListener('click', copyLobbyId);
    }

    // Reaction bar event listeners
    reactionEmojis.addEventListener('click', (e) => {
        const btn = e.target.closest('.reaction-emoji');
        if (!btn) return;
        sendMessage({ action: 'reaction', type: 'emoji', content: btn.dataset.emoji });
    });

    reactionSendBtn.addEventListener('click', sendReactionText);
    reactionTextInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendReactionText();
    });
});

function copyLobbyId() {
    const lobbyIdSpan = document.getElementById('current-lobby-id');
    const lobbyId = lobbyIdSpan.textContent;

    // Use the modern clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(lobbyId).then(() => {
            showCopyFeedback(lobbyIdSpan);
        }).catch(() => {
            // Fallback for older browsers
            fallbackCopyToClipboard(lobbyId, lobbyIdSpan);
        });
    } else {
        // Fallback for older browsers
        fallbackCopyToClipboard(lobbyId, lobbyIdSpan);
    }
}

function applyCardLayout() {
    if (localStorage.getItem('unoCardLayout') !== 'wrap') {
        playerHandDiv.classList.add('scroll-mode');
        cardLayoutToggle.textContent = '切换到换行排列';
    } else {
        playerHandDiv.classList.remove('scroll-mode');
        cardLayoutToggle.textContent = '切换到滚动排列';
    }
    updateScrollAlignment();
}

function updateScrollAlignment() {
    const isScroll = playerHandDiv.classList.contains('scroll-mode');
    if (!isScroll) { playerHandDiv.style.justifyContent = ''; return; }
    playerHandDiv.style.justifyContent = playerHandDiv.scrollWidth > playerHandDiv.clientWidth ? 'flex-start' : 'center';
}

cardLayoutToggle.addEventListener('click', () => {
    playerHandDiv.classList.toggle('scroll-mode');
    const isScroll = playerHandDiv.classList.contains('scroll-mode');
    localStorage.setItem('unoCardLayout', isScroll ? 'scroll' : 'wrap');
    cardLayoutToggle.textContent = isScroll ? '切换到换行排列' : '切换到滚动排列';
    updateScrollAlignment();
});

function sendReactionText() {
    const text = reactionTextInput.value.trim();
    if (!text) return;
    let width = 0;
    for (const ch of text) {
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) width += 1;
        else width += 0.3;
    }
    if (width > 64) {
        showAlert('消息过长！');
        return;
    }
    sendMessage({ action: 'reaction', type: 'text', content: text });
    reactionTextInput.value = '';
}

function fallbackCopyToClipboard(text, element) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        document.execCommand('copy');
        showCopyFeedback(element);
    } catch (err) {
        console.error('Failed to copy lobby ID:', err);
    }

    document.body.removeChild(textArea);
}

function showCopyFeedback(element) {
    const originalText = element.textContent;
    element.textContent = '已复制！';
    element.style.background = 'rgba(72, 187, 120, 0.3)';

    setTimeout(() => {
        element.textContent = originalText;
        element.style.background = 'rgba(255,255,255,0.2)';
    }, 1000);
}

function showDisconnectedToast(reason) {
    const toast = document.getElementById('disconnected-toast') || createDisconnectedToast();
    // if (reason === 'action') {
    //     toast.textContent = '';
    // } else {
    toast.textContent = '连接已断开，正在重连... 如持续失败请刷新页面';
    // }
    toast.classList.add('visible');
    clearTimeout(disconnectToastTimeout);
}

function hideDisconnectedToast() {
    const toast = document.getElementById('disconnected-toast');
    if (toast) {
        toast.classList.remove('visible');
    }
    clearTimeout(disconnectToastTimeout);
}

function createDisconnectedToast() {
    const toast = document.createElement('div');
    toast.id = 'disconnected-toast';
    document.body.appendChild(toast);
    return toast;
}

function createLeaveLobbyButton() {
    const leaveLobbyBtn = document.createElement('button');
    leaveLobbyBtn.id = 'leave-lobby';
    leaveLobbyBtn.textContent = '离开大厅';
    leaveLobbyBtn.classList.add('leave-lobby-btn');
    leaveLobbyBtn.addEventListener('click', leaveLobby);
    return leaveLobbyBtn;
}

async function leaveLobby() {
    const confirmed = await showConfirm('确定要离开大厅吗？');
    if (!confirmed) return;

    sendMessage({ action: 'leave' });
    localStorage.removeItem('unoPlayerId');
    localStorage.removeItem('unoInLobby');
    localStorage.removeItem('unoInGame');
    localStorage.setItem('unoLeftLobby', 'true');
    requestAnimationFrame(() => resetGameState())
}

function showJoinForm() {
    joinFormContainer.style.display = 'block';

    // Remove leave lobby button if it exists
    const existingLeaveBtn = document.getElementById('leave-lobby');
    if (existingLeaveBtn) {
        existingLeaveBtn.remove();
    }
}

function hideJoinForm() {
    joinFormContainer.style.display = 'none';

    // Add leave lobby button if it doesn't exist
    let leaveLobbyBtn = document.getElementById('leave-lobby');
    if (!leaveLobbyBtn) {
        leaveLobbyBtn = createLeaveLobbyButton();
        // Insert after lobby info
        const lobbyInfo = document.getElementById('lobby-info');
        lobbyInfo.parentNode.insertBefore(leaveLobbyBtn, lobbyInfo.nextSibling);
    }
}

function hideLobbyInfo() {
    lobbyInfo.style.display = 'none';
    showJoinForm();
}

const gameOverOverlay = document.getElementById('game-over-overlay');
const gameOverTitle = document.getElementById('game-over-title');
const gameOverMessage = document.getElementById('game-over-message');
const gameOverIcon = document.getElementById('game-over-icon');
const gameOverContent = document.getElementById('game-over-content');
const gameOverBtn = document.getElementById('game-over-btn');

let isGameOverShowing = false;

function showGameOver(winnerName) {
    if (isGameOverShowing) return;
    isGameOverShowing = true;
    localStorage.removeItem('unoInLobby');
    localStorage.removeItem('unoInGame');

    const isWinner = winnerName === players.find(p => p.id === myId)?.name;
    const myName = localStorage.getItem('unoPlayerName') || '';

    if (isWinner) {
        gameOverIcon.textContent = '🏆';
        gameOverTitle.textContent = '你赢了！';
        gameOverMessage.textContent = `🎉 ${encodeUGC(winnerName)} 赢得了游戏！干得漂亮！`;
        gameOverContent.className = 'win';
        spawnConfetti();
    } else {
        gameOverIcon.textContent = '💔';
        gameOverTitle.textContent = '游戏结束';
        gameOverMessage.textContent = `${encodeUGC(winnerName)} 赢得了游戏！\n下次加油，${encodeUGC(myName)}！`;
        gameOverContent.className = 'lose';
    }

    gameOverOverlay.classList.remove('hidden');
    gameOverOverlay.style.display = 'flex';
}

function showGameAborted() {
    if (isGameOverShowing) return;
    isGameOverShowing = true;
    localStorage.removeItem('unoInLobby');
    localStorage.removeItem('unoInGame');

    gameOverIcon.textContent = '⚡';
    gameOverTitle.textContent = '对局中止';
    gameOverMessage.textContent = '其他玩家离开了对局，游戏已结束';
    gameOverContent.className = 'aborted';

    gameOverOverlay.classList.remove('hidden');
    gameOverOverlay.style.display = 'flex';
}

function showReaction(playerId, type, content) {
    const playerDiv = opponentHandsDiv.querySelector(`[data-player-id="${playerId}"]`);
    if (!playerDiv && playerId !== myId) return;

    const popup = document.createElement('div');
    popup.classList.add('reaction-popup');
    if (type === 'text') popup.classList.add('reaction-popup-text');
    popup.textContent = content;

    let width = 0;
    for (const ch of content) {
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) width += 1;
        else width += 0.3;
    }
    const duration = Math.max(1.5, Math.min(5, 1 + width * 0.1));
    popup.style.animationDuration = duration + 's';

    if (playerDiv) {
        playerDiv.appendChild(popup);
    } else {
        // Self reaction: show above reaction bar
        const reactionBar = document.getElementById('reaction-bar');
        if (reactionBar) {
            popup.style.position = 'absolute';
            popup.style.bottom = '100%';
            popup.style.left = '50%';
            popup.style.transform = 'translateX(-50%)';
            reactionBar.appendChild(popup);
        }
    }

    popup.addEventListener('animationend', () => popup.remove(), { once: true });
}

gameOverBtn.addEventListener('click', () => {
    gameOverOverlay.classList.add('hidden');
    gameOverOverlay.style.display = '';
    isGameOverShowing = false;
    requestAnimationFrame(() => resetGameState());
});

function spawnConfetti() {
    const colors = ['#ff6b6b', '#ffd700', '#48bb78', '#667eea', '#ff8a5c', '#f1c40f', '#e74c3c', '#3498db', '#2ecc71'];
    const container = document.body;

    for (let i = 0; i < 80; i++) {
        const el = document.createElement('div');
        el.classList.add('confetti');
        el.style.left = Math.random() * 100 + 'vw';
        el.style.background = colors[Math.floor(Math.random() * colors.length)];
        el.style.width = (Math.random() * 8 + 4) + 'px';
        el.style.height = (Math.random() * 8 + 4) + 'px';
        el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
        el.style.animationDuration = (Math.random() * 2 + 2) + 's';
        el.style.animationDelay = (Math.random() * 2) + 's';
        container.appendChild(el);

        setTimeout(() => el.remove(), 5000);
    }
}

function __callWin__() {
    sendMessage({ action: 'dev_call_win' });
}

// Dev Panel — press Ctrl+Shift+D to toggle; auto-shown when server is in dev mode
let devPanelSetup = false;
function setupDevPanel() {
    if (devPanelSetup) return;
    devPanelSetup = true;

    const panel = document.getElementById('dev-panel');
    if (!panel) return;

    panel.style.display = '';

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
            e.preventDefault();
            panel.classList.toggle('collapsed');
        }
    });

    // Toggle collapse on header click
    const header = document.getElementById('dev-panel-header');
    header.addEventListener('click', () => {
        panel.classList.toggle('collapsed');
    });

    // Dev button click handlers
    panel.addEventListener('click', (e) => {
        const btn = e.target.closest('.dev-btn');
        if (!btn) return;

        const action = btn.dataset.action;
        if (action === 'dev_disconnect') {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close(4001, 'dev disconnect');
                btn.textContent = '重连';
            } else if (ws && ws.readyState === WebSocket.CLOSED) {
                btn.textContent = '断开';
                connect();
            }
            return;
        }

        const count = btn.dataset.count ? parseInt(btn.dataset.count) : undefined;

        const msg = { action };
        if (count !== undefined) msg.count = count;
        sendMessage(msg);
    });
}

(function initDevPanel() {
    // Prepare panel hidden; setupDevPanel will be called when 'init' message confirms dev mode
    const panel = document.getElementById('dev-panel');
    if (panel) panel.style.display = 'none';
})();
