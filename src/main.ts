import "./style.css";
import { VJApp } from "./app/VJApp";

const host = document.querySelector<HTMLDivElement>("#app");
if (!host) throw new Error("#app not found");

const app = new VJApp();
void app.init(host);
