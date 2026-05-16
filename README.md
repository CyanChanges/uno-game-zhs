# 🃏 UNO Web Game

A modern, real-time multiplayer UNO card game built with WebSockets, featuring beautiful UI, advanced lobby system, and smooth gameplay experience.

![UNO Game](https://img.shields.io/badge/Game-UNO-red?style=for-the-badge)
![WebSocket](https://img.shields.io/badge/WebSocket-Real--time-blue?style=for-the-badge)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow?style=for-the-badge)

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v16 or higher)
- **pnpm** package manager

### Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd uno
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

<!-- 3. **Install Go, Go-Winres and `jq`**  
   see <https://go.dev/doc/install> and <https://jqlang.org/download/>

   and
   ```sh
   go install github.com/tc-hib/go-winres@latest
   ``` -->

4. **Start the game server**

   ```bash
   pnpm start
   ```

5. **Open your browser**
   Navigate to `http://localhost:3000`

### Quick Start

1. Enter your name (2-20 characters, must be unique in lobby)
2. Leave lobby ID empty to create a new lobby, or enter an existing lobby ID
3. Click "Join Game"
4. Share the lobby ID with friends
5. Click "Ready" when all players have joined
6. Game starts automatically when all players are ready!

## 📋 Game Rules

### 🎯 Objective

Be the first player to get rid of all your cards!

### 🃏 Card Types

- **Number Cards (0-9)**: Match color or number
- **Skip Cards**: Next player loses their turn
- **Reverse Cards**: Reverse the direction of play
- **Draw 2 Cards**: Next player draws 2 cards and loses their turn
- **Wild Cards**: Change the color, can be played anytime
- **Wild +4 Cards**: Change color AND next player draws 4 cards and loses their turn

### 🎮 Gameplay

1. **Starting**: Each player gets 7 cards
2. **Playing**: Match the top card by color, number, or play a wild card
3. **Drawing**: If you can't play, draw a card from the deck
4. **UNO**: Automatically announced when you have 1 card left
5. **Multiple Cards**: You can play multiple cards of the same number in one turn

6. **Winning**: First player to play all cards wins!

### 🔄 Special Card Effects

- **Skip**: Skips the next player's turn
- **Reverse**: Changes direction of play
- **Draw 2**: Next player draws 2 cards and is skipped
- **Wild**: Choose any color to continue play
- **Wild +4**: Choose color, next player draws 4 cards and is skipped

## 🛠 Development

### 📁 Project Structure

```
uno/
├── client.js          # Frontend game logic and UI
├── server.js          # WebSocket server and game engine
├── index.html         # Game interface
├── style.css          # Modern UI styling
├── package.json       # Dependencies and scripts
├── vite.config.js     # Vite configuration
└── test/
    ├── setup.js       # Test environment setup
    └── client.test.js # Frontend tests
```

## 📝 License

This project is open source and available under the [BSD 3-Clause License](LICENSE).

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

**Enjoy playing UNO!** 🎉🃏
