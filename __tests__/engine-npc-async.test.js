jest.mock('../npc-orchestrator', () => ({
  decideNpcAction: jest.fn(),
}));

const random = require('../random');
const { decideNpcAction } = require('../npc-orchestrator');
const { PokerGame, NPC_DELAY_MIN } = require('../engine');

describe('engine async npc integration', () => {
  test('processNPCTurn awaits orchestrator and applies exactly one action', async () => {
    jest.useFakeTimers();
    const randomSpy = jest.spyOn(random, 'randomInt').mockReturnValue(0);

    try {
      decideNpcAction.mockResolvedValue({
        action: 'call',
        _decisionSource: 'fallback',
      });

      const game = new PokerGame('npc_async_room', { smallBlind: 10, bigBlind: 20 });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const npc = game.addPlayer({
        id: 'n1',
        name: 'Bot',
        isNPC: true,
        npcProfile: { name: 'Bot', style: 'balanced', tightness: 0.5, bluffFreq: 0.2, aggression: 0.5, cbetFreq: 0.6, checkRaiseFreq: 0.1 },
      });
      game.addPlayer({ id: 'h1', name: 'Hero' });
      game.startRound();

      const actionSpy = jest.spyOn(game, 'handleAction');
      game.currentPlayerIndex = npc.seatIndex;
      game.currentBet = 40;
      npc.bet = 20;
      npc.totalBet = 20;
      game.processNPCTurn();

      jest.advanceTimersByTime(NPC_DELAY_MIN + 100);
      await Promise.resolve();
      await Promise.resolve();

      expect(decideNpcAction).toHaveBeenCalledTimes(1);
      expect(actionSpy).toHaveBeenCalledTimes(1);
      expect(actionSpy).toHaveBeenCalledWith(npc.id, 'call', undefined);
      expect(npc.lastAction).toMatchObject({ action: 'call' });
    } finally {
      randomSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('processNPCTurn records runtime rollout summary for solver hits', async () => {
    jest.useFakeTimers();
    const randomSpy = jest.spyOn(random, 'randomInt').mockReturnValue(0);

    try {
      decideNpcAction.mockImplementation(async ({ gameState }) => {
        gameState._decisionTrace = {
          status: 'solver_hit',
          reason: 'solver_strategy_applied',
          lookupSource: 'root_cache',
          classification: 'solver_hit',
          latencyMs: 7.25,
        };
        gameState._solverTrace = {
          reason: 'ok',
          classification: 'solver_hit',
          lookupSource: 'root_cache',
          lookupMs: 7.25,
        };
        return { action: 'check', _solver: true };
      });

      const game = new PokerGame('npc_rollout_room', { smallBlind: 10, bigBlind: 20 });
      game.onMessage = () => {};
      game.onUpdate = () => {};
      game.onChat = () => {};
      game.onRoundEnd = () => {};

      const npc = game.addPlayer({
        id: 'n1',
        name: 'Bot',
        isNPC: true,
        npcProfile: {
          name: 'Bot',
          style: 'balanced',
          tightness: 0.5,
          bluffFreq: 0.2,
          aggression: 0.5,
          cbetFreq: 0.6,
          checkRaiseFreq: 0.1,
        },
      });
      game.addPlayer({ id: 'h1', name: 'Hero' });
      game.startRound();

      const logSpy = jest.spyOn(game, '_logEvent');
      game.currentPlayerIndex = npc.seatIndex;
      game.currentBet = 20;
      npc.bet = 20;
      npc.totalBet = 20;
      game.processNPCTurn();

      jest.advanceTimersByTime(NPC_DELAY_MIN + 100);
      await Promise.resolve();
      await Promise.resolve();

      expect(
        logSpy.mock.calls.find(([event]) => event === 'runtime_rollout_summary')
      ).toBeTruthy();
      expect(
        logSpy.mock.calls.find(([event, data]) => event === 'runtime_rollout_summary' && data.lookupSources?.root_cache === 1)
      ).toBeTruthy();
    } finally {
      randomSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
