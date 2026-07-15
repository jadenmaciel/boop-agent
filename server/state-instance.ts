import { StateStore } from "./state.js";

let store: StateStore | null = null;

export function getStateStore(): StateStore {
  store ??= new StateStore();
  return store;
}
