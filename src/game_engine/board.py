BOARD_SIZE = 8
EMPTY = 0
BLACK = 1
WHITE = -1

DIRECTIONS = [
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1),           (0, 1),
    (1, -1),  (1, 0),  (1, 1),
]

class Board:
    def __init__(self, size=8):
        self.size = size
        self.board = [[EMPTY] * size for _ in range(size)]
        self.current_player = BLACK
        self.game_over = False
        self.reset()

    def reset(self):
        s = self.size
        self.board = [[EMPTY] * s for _ in range(s)]
        mid = s // 2
        self.board[mid - 1][mid - 1] = WHITE
        self.board[mid][mid] = WHITE
        self.board[mid - 1][mid] = BLACK
        self.board[mid][mid - 1] = BLACK
        self.current_player = BLACK
        self.game_over = False

    def in_bounds(self, r, c):
        return 0 <= r < self.size and 0 <= c < self.size

    def opponent(self, player):
        return -player

    def _flips_in_direction(self, r, c, player, dr, dc):
        flips = []
        rr, cc = r + dr, c + dc
        while self.in_bounds(rr, cc) and self.board[rr][cc] == self.opponent(player):
            flips.append((rr, cc))
            rr += dr
            cc += dc
        if flips and self.in_bounds(rr, cc) and self.board[rr][cc] == player:
            return flips
        return []

    def get_flips(self, r, c, player):
        if not self.in_bounds(r, c) or self.board[r][c] != EMPTY:
            return []
        flips = []
        for dr, dc in DIRECTIONS:
            flips.extend(self._flips_in_direction(r, c, player, dr, dc))
        return flips

    def is_legal(self, r, c, player=None):
        if player is None:
            player = self.current_player
        return len(self.get_flips(r, c, player)) > 0

    def legal_moves(self, player=None):
        if player is None:
            player = self.current_player
        moves = []
        for r in range(self.size):
            for c in range(self.size):
                if self.board[r][c] == EMPTY and self.is_legal(r, c, player):
                    moves.append((r, c))
        return moves

    def step(self, r, c):
        if self.game_over:
            raise ValueError("Game is over")
        player = self.current_player
        flips = self.get_flips(r, c, player)
        if not flips:
            raise ValueError(f"Illegal move: {(r, c)} for player {player}")

        self.board[r][c] = player
        for rr, cc in flips:
            self.board[rr][cc] = player

        next_player = self.opponent(player)
        if self.legal_moves(next_player):
            self.current_player = next_player
        else:
            if self.legal_moves(player):
                self.current_player = player
            else:
                self.game_over = True
                self.current_player = next_player
        return flips

    def is_terminal(self):
        if self.game_over:
            return True
        if not self.legal_moves(BLACK) and not self.legal_moves(WHITE):
            return True
        return False

    def score(self):
        black = sum(row.count(BLACK) for row in self.board)
        white = sum(row.count(WHITE) for row in self.board)
        return black, white

    def winner(self):
        black, white = self.score()
        if black > white: return BLACK
        elif white > black: return WHITE
        else: return 0

    def clone(self):
        new = Board(self.size)
        new.board = [row[:] for row in self.board]
        new.current_player = self.current_player
        new.game_over = self.game_over
        return new

    def __str__(self):
        symbols = {EMPTY: ".", BLACK: "X", WHITE: "O"}
        lines = ["  " + " ".join(str(c) for c in range(self.size))]
        for r in range(self.size):
            lines.append(str(r) + " " + " ".join(symbols[self.board[r][c]] for c in range(self.size)))
        return "\n".join(lines)