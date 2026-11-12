/** Boat sandbox ids survive restarts, unlike hostnames. Production is absent from this registry.
 * SSH observes the sandbox before bootstrapping; receipts retain the current hostname and boot. */
export const hosts = {
  'cloudbox-konan': 'bx_gu65277z',
  'cloudbox-konan2': 'bx_8b9c35bp',
  'cloudbox-konan3': 'bx_5suus7qp',
  'cloudbox-konan4': 'bx_u4e5vmtn',
}

/** The developer PC runs the proof stack in WSL and the Android emulator on Windows' GPU.
 * Its WSL systemd machine id survives WSL and Windows restarts, as BOAT_ID does on a devbox,
 * and is read locally; hostnames are shared by Windows and WSL and identify nothing. */
export const pc = { alias: 'pc', machineId: 'c0645291cfa343108194237d1b3cf5ba' }
