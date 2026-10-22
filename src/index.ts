import { AnomalyScheduler } from './anomalies.js';
import { config } from './config.js';
import { Sampler, type Reading } from './sampler.js';
import { createSensors, type Sensor } from './sensors.js';
import { Station } from './station.js';

const station = new Station(config.startHour);
const anomalies = new AnomalyScheduler(station, (message) => console.log(`${clock()}  ⚠ ${message}`));

// На КП 2 (крок 5) замість лічильника тут буде відправка в MQTT-брокер
let readingsThisSecond = 0;
const sampler = new Sampler(createSensors(station), (reading: Reading, sensor: Sensor) => {
  readingsThisSecond++;
  // Подієві сигнали трапляються рідко, тому показуємо кожен
  if (sensor.frequency === 'event') {
    console.log(`${clock()}  ● ${reading.sensorId} = ${reading.value}`);
  }
});

/** Симульований час доби у форматі «День 1, 06:00». */
function clock(): string {
  const totalMinutes = Math.floor(station.time / 60);
  const day = Math.floor(totalMinutes / (24 * 60)) + 1;
  const hours = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `День ${day}, ${hours}:${minutes}`;
}

/** Короткий підсумок стану раз на реальну секунду, щоб бачити, що відбувається. */
function printStatus(): void {
  const [pump1, pump2] = station.pumps;
  console.log(
    `${clock()}  Q=${station.flow.toFixed(0)} м³/год  ` +
      `p_in=${station.inletPressure.toFixed(2)}  p_out=${station.outletPressure.toFixed(2)} бар  ` +
      `Н1: ${pump1.state} ${pump1.speed.toFixed(0)} об/хв, v=${pump1.vibration.toFixed(2)}, T=${pump1.bearingTemperature.toFixed(1)}°C  ` +
      `Н2: ${pump2.state}  | ${readingsThisSecond} вимірювань/с`,
  );
  readingsThisSecond = 0;
}

const simulatedSecondsPerTick = (config.tickMs / 1000) * config.timeScale;
const ticksPerSecond = 1000 / config.tickMs;
let tick = 0;

setInterval(() => {
  station.step(simulatedSecondsPerTick);
  anomalies.step(simulatedSecondsPerTick);
  sampler.sample(tick);
  if (tick % ticksPerSecond === 0) printStatus();
  tick++;
}, config.tickMs);
