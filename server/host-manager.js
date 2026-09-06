function getHumanPlayers(game) {
  return game.players.filter((p) => !p.isNPC);
}

function createHostManager({ games, io, graceMs }) {
  function clearHostTransferTimer(game) {
    if (game._hostTransferTimer) {
      clearTimeout(game._hostTransferTimer);
      game._hostTransferTimer = null;
    }
  }

  function assignHost(game, options = {}) {
    const respectGrace = options.respectGrace !== false;
    const humans = getHumanPlayers(game);
    if (humans.length === 0) {
      game.hostPlayerId = null;
      clearHostTransferTimer(game);
      return null;
    }

    const currentHost = humans.find((p) => p.uid === game.hostPlayerId);
    if (currentHost) {
      if (currentHost.isConnected !== false) {
        clearHostTransferTimer(game);
        return currentHost;
      }
      const disconnectedAt = currentHost.disconnectedAt || Date.now();
      if (respectGrace && Date.now() - disconnectedAt < graceMs) return currentHost;
    }

    const nextHost = humans.find((p) => p.isConnected !== false) || currentHost || humans[0];
    game.hostPlayerId = nextHost.uid;
    if (nextHost.isConnected !== false) clearHostTransferTimer(game);
    return nextHost;
  }

  function transferHostIfStale(roomId) {
    const game = games.get(roomId);
    if (!game) return;
    const previousHostId = game.hostPlayerId;
    const nextHost = assignHost(game, { respectGrace: false });
    if (nextHost && nextHost.uid !== previousHostId && nextHost.isConnected !== false) {
      io.to(roomId).emit('gameMessage', `${nextHost.name} is now the room host`);
      game.emitUpdate(game);
    }
  }

  function scheduleHostTransfer(roomId, game) {
    clearHostTransferTimer(game);
    const currentHost = getHumanPlayers(game).find((p) => p.uid === game.hostPlayerId);
    if (!currentHost || currentHost.isConnected !== false) return;
    if (
      !getHumanPlayers(game).some((p) => p.uid !== currentHost.uid && p.isConnected !== false)
    ) {
      return;
    }
    const elapsed = Date.now() - (currentHost.disconnectedAt || Date.now());
    const delay = Math.max(0, graceMs - elapsed);
    game._hostTransferTimer = setTimeout(() => transferHostIfStale(roomId), delay);
    if (game._hostTransferTimer.unref) game._hostTransferTimer.unref();
  }

  function requireHost(socket, game) {
    const host = assignHost(game);
    const player = game.players.find((p) => p.id === socket.id && !p.isNPC);
    // Compared by uid, never by display name. A name is user-chosen, so
    // matching on it makes host authority depend on a uniqueness invariant
    // enforced elsewhere; any path that ever admits a duplicate name would
    // become privilege escalation.
    if (host && player && player.uid && player.uid === host.uid) return true;
    socket.emit('error', { message: 'Only the room host can do that' });
    return false;
  }

  return {
    assignHost,
    clearHostTransferTimer,
    requireHost,
    scheduleHostTransfer,
    transferHostIfStale,
  };
}

module.exports = { createHostManager, getHumanPlayers };
