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

function connect() {
    const wsUrl = new URL('/ws', location.href)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('Connected to server');
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.action === 'init') {
            myId = message.id;
            if (message.dev) setupDevPanel();
            return;
        }

        if (message.action === 'error') {
            showAlert(message.message).then(() => {
                nameInput.disabled = false;
                lobbyIdInput.disabled = false;
                joinButton.disabled = false;
            });
            return;
        }

        if (message.action === 'players') {
            players = message.players;
            currentTurn = message.turn;
            myLobbyId = message.lobbyId;
            updatePlayers(message.players, message.turn);
            updateTurnIndicator();
            showLobbyInfo(message.lobbyId);
        }

        if (message.action === 'start') {
            myId = message.id;
            lobbyDiv.style.display = 'none';
            gameDiv.style.display = 'block';
            players = message.players;
            currentTurn = message.turn;
            myHand = message.hand;
            updatePlayers(message.players, message.turn);
            updateHand(message.hand);
            updateDiscardPile(message.discardPile);
            updateTurnIndicator();
        }

        if (message.action === 'update') {
            players = message.players;
            currentTurn = message.turn;
            myHand = message.hand;
            updatePlayers(message.players, message.turn);
            updateHand(message.hand);
            updateDiscardPile(message.discardPile);
            updateTurnIndicator();
        }

        if (message.action === 'win') {
            showGameOver(message.winner);
        }

        if (message.action === 'game_aborted') {
            showGameAborted();
        }
    };

    ws.onclose = (event) => {
        console.log('Disconnected from server. Reconnecting...', event.code, event.reason);
        // Only reconnect if it wasn't a manual close
        if (event.code !== 1000) {
            setTimeout(connect, 1000);
        }
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        // Don't manually close on error, let the browser handle it
    };
}

function canSendMessage() {
    return ws && ws.readyState === WebSocket.OPEN;
}

function sendMessage(message) {
    if (canSendMessage()) {
        ws.send(JSON.stringify(message));
    } else {
        console.warn('WebSocket is not connected. Message not sent:', message);
    }
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
    // Reset to lobby
    lobbyDiv.style.display = 'block';
    gameDiv.style.display = 'none';

    requestAnimationFrame(() => {

        nameInput.value = (localStorage.getItem('unoPlayerName') || '').trim();
        console.log(nameInput.value)
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

        // Check for UNO condition (1 card or multiple same-number cards)
        if (player.hand && isUnoCondition(player.hand)) {
            playerDiv.classList.add('uno');
        }

        // Add creator styling to opponent display too
        if (player.isCreator) {
            playerDiv.classList.add('creator');
        }

        if (player.isAI) {
            playerDiv.classList.add('ai');
        }

        let displayText = player.name;
        if (player.isCreator) {
            displayText += ' 👑';
        }
        if (player.isAI) {
            displayText += ' 🤖';
        }

        // `textContent` is safe
        if (player.hand) {
            playerDiv.textContent = `${displayText}（${player.hand.length} 张牌）`;
        } else {
            playerDiv.textContent = displayText;
        }

        if (player.id !== myId) {
            opponentHandsDiv.appendChild(playerDiv);
        }

        const li = document.createElement('li');
        li.classList.add('player-row');
        if (player.isCreator) li.classList.add('creator');
        if (player.isAI) li.classList.add('ai');

        const nameSpan = document.createElement('span');
        nameSpan.classList.add('player-name');
        let nameText = player.name;
        if (player.isCreator) nameText += ' 👑';
        if (player.isAI) nameText += ' 🤖';
        if (player.ready) nameText += '（已准备）';
        nameSpan.textContent = nameText;
        if (i === turn) nameSpan.style.fontWeight = 'bold';
        li.appendChild(nameSpan);

        // Ready button for unready AI players (only visible to creator)
        const me = players.find(p => p.id === myId);
        if (player.isAI && me && me.isCreator) {
            const actionsDiv = document.createElement('span');
            actionsDiv.classList.add('ai-actions');

            const readyAiBtn = document.createElement('button');
            readyAiBtn.textContent = player.ready ? '取消' : '就绪';
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

        playersList.appendChild(li);
    }

    // Show/hide invite AI button
    const me = players.find(p => p.id === myId);
    if (inviteAIBtn) {
        inviteAIBtn.style.display = (me && me.isCreator) ? '' : 'none';
    }
    if (readyButton && me) {
        readyButton.textContent = me.ready ? '取消' : '就绪';
    }
}

function isUnoCondition(hand) {
    if (hand.length === 1) return true;

    // Check if all cards have the same number/type
    if (hand.length > 1) {
        const firstCard = hand[0];
        return hand.every(card => card.type === firstCard.type && card.type !== 'wild' && card.type !== 'wild4');
    }

    return false;
}

function updateHand(hand) {
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
}

function handleCardClick(card, cardIndex, hand) {
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

    const message = { action: 'join', name: name };
    if (lobbyId) {
        message.lobbyId = lobbyId;
    }
    sendMessage(message);
});

if (inviteAIBtn) {
    inviteAIBtn.addEventListener('click', () => {
        sendMessage({ action: 'add_ai' });
    });
}

readyButton.addEventListener('click', () => {
    sendMessage({ action: 'ready' });
});

drawCardButton.addEventListener('click', () => {
    sendMessage({ action: 'draw' });
});

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

    gameOverIcon.textContent = '⚡';
    gameOverTitle.textContent = '对局中止';
    gameOverMessage.textContent = '其他玩家离开了对局，游戏已结束';
    gameOverContent.className = 'aborted';

    gameOverOverlay.classList.remove('hidden');
    gameOverOverlay.style.display = 'flex';
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
function setupDevPanel() {
    const panel = document.getElementById('dev-panel');
    if (!panel) return;

    panel.style.display = '';

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
            e.preventDefault();
            panel.style.display = panel.style.display === 'none' ? '' : 'none';
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
