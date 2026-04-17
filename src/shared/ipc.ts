export const IPC_STATUS = 'murmur:status';
export const IPC_START_RECORDING = 'murmur:start-recording';
export const IPC_STOP_RECORDING = 'murmur:stop-recording';
export const IPC_AUDIO_CHUNK = 'murmur:audio-chunk';

export type Status =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'refining'
  | 'injecting'
  | 'done'
  | 'error';
