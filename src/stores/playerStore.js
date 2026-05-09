import { writable } from 'svelte/store';

export const playerState = writable({
  currentTrack: null,
  isPlaying: false,
  progress: 0,
});

export const updatePlayerState = (updates) => {
  playerState.update((state) => ({ ...state, ...updates }));
};