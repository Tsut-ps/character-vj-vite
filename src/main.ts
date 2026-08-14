import "./style.css";
import { VJApp } from "./app/VJApp";

const host = document.querySelector<HTMLDivElement>("#app");
if (!host) throw new Error("#app not found");

const app = new VJApp();

/** 初期化失敗を未処理Promiseにせず原因をコンソールへ残す */
async function startApp(target: HTMLElement): Promise<void> {
  try {
    await app.init(target);
  } catch (error) {
    console.error("Character VJ initialization failed", error);
  }
}

void startApp(host);

// HMRで旧インスタンスの入力監視やWebGLリソースが残らないよう破棄する
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
