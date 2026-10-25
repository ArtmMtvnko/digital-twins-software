import { AnomalyScheduler } from './anomalies.ts';
import { config } from './config.ts';
import { Publisher } from './publisher.ts';
import { Sampler, type Reading } from './sampler.ts';
import { createSensors, type Sensor } from './sensors.ts';
import { Station } from './station.ts';

const station = new Station(config.startHour);
const anomalies = new AnomalyScheduler(station, (message) => console.log(`${clock()}  ⚠ ${message}`));

const publisher = new Publisher();

let readingsThisSecond = 0;
const sampler = new Sampler(createSensors(station), (reading: Reading, sensor: Sensor) => {
  publisher.publish(reading, sensor);
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
      `Н2: ${pump2.state}  | надіслано ${readingsThisSecond} повідомлень/с`,
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

// Ctrl+C: коректно відключаємося від брокера
process.on('SIGINT', async () => {
  await publisher.close();
  process.exit(0);
});
