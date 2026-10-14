
export const MODEL_CONFIG = {
  productName: 'BioPod',
  tagline:
    'IoT Incubator for bacterial culture',
  revision: 'Rev A',


  glbUrl: '/models/container.glb',

  animation: {
    openClips: ['Open', 'LidOpen', 'Lid_Open', 'OpenContainer', 'Opening'],
    closeClips: ['Close', 'LidClose', 'Lid_Close', 'CloseContainer', 'Closing'],
    lidFallback: { axis: 'z', angleDeg: 110, direction: -1 },
  },

  camera: {
    position: [1, 0.0, 1.5],
    target: [0, 0, 0],
    fov: 50,
    minDistance: 0,
    maxDistance: 7,
  },
}

// Each entry maps a friendly UI component to the object name(s) in the model.
//  - meshNames:     Blender object names to look for (first match wins)
//  - explodeOffset: [x, y, z] offset in model units when exploded view is on
//  - labelAnchor:   [x, y, z] position of the 3D marker, local to the component
export const COMPONENTS = [
  {
    id: 'body',
    label: 'Container body',
    meshNames: ['ContainerBody', 'Body', 'Container'],
    description: 'Styrofoam body with four walls and a floor. It is covered with aluminum heat shielding.',
    explodeOffset: [0,0,-.5],
    labelAnchor: [0,0,0],
  },
  {
    id: 'lid',
    label: 'Lid',
    meshNames: ['Lid', 'Cover', 'Top'],
    description: 'Lid that covers the container. Made of Glass.',
    explodeOffset: [0,0,.3],
    labelAnchor: [0,0,0],
  },
  {
    id: 'tray',
    label: 'Inner tray',
    meshNames: ['InnerTray', 'Tray', 'Inner_Tray'],
    description: 'Removable divided tray that rests on removable rods inside the container. It holds the culture sample.',
    explodeOffset: [-.3,0,0],
    labelAnchor: [0,0,0],
  },
  {
    id: 'sensor',
    label: 'Sensor module',
    meshNames: ['SensorModule', 'Sensor', 'Sensor_Module'],
    description: 'Four Temperature and humidity monitors mounted on top. Readings appear in the dashboard.',
    explodeOffset: [0,0,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'PetriDish',
    label: 'Petridish',
    meshNames: ['PetriDish'],
    description: 'Holds the culture sample inside the chamber. The controller keeps the air around it at the setpoint, 37 °C and 50 % RH by default.',
    explodeOffset: [.3,0,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'Humidifier',
    label: 'Humidifier',
    meshNames: ['Humidifier'],
    description: 'Adds moisture to the chamber air. It switches on when humidity falls about 2 % RH below the setpoint and off once it is about 2 % above.',
    explodeOffset: [0,.1,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'WaterReservoirLid',
    label: 'WaterReservoirLid',
    meshNames: ['WaterReservoirLid'],
    description: 'Removable cap of the water reservoir. Take it off to refill the tank that feeds the humidifier.',
    explodeOffset: [0,-.1,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'WaterReservoirBottom',
    label: 'WaterReservoirBottom',
    meshNames: ['WaterReservoirBottom'],
    description: 'Tank section of the water reservoir. It stores the water supply that the humidifier draws from.',
    explodeOffset: [0,-.11,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'ESP32',
    label: 'ESP32',
    meshNames: ['ESP32'],
    description: 'Main controller. It reads the four temperature and humidity sensors every 5 s, switches the heater, Peltier, fan and humidifier, and sends readings to the dashboard over Wi-Fi.',
    explodeOffset: [.14,.1,0],
    labelAnchor: [0,0,0],
  },
    {
    id: '4.0 Touchscreen',
    label: '4.0 Touchscreen',
    meshNames: ['Touchscreen'],
    description: '4.0-inch touch display on the front of the unit for viewing readings and settings at the device.',
    explodeOffset: [-.14,.1,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'PTC Heater',
    label: 'PTC Heater',
    meshNames: ['PTCHeater'],
    description: 'Warms the chamber. It switches on when the average temperature drops about 0.2 °C below the setpoint and off once it is about 0.2 °C above. It never runs at the same time as the Peltier.',
    explodeOffset: [0,.2,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'BlowerFan',
    label: 'BlowerFan',
    meshNames: ['BlowerFan'],
    description: 'Runs continuously to circulate air so heat and humidity spread evenly through the chamber.',
    explodeOffset: [0,.5,.1],
    labelAnchor: [0,0,0],
  },
    {
    id: 'PeltierModule',
    label: 'PeltierModule',
    meshNames: ['PeltierModule'],
    description: 'Thermoelectric cooler. It switches on only when the temperature rises more than 0.5 °C above the setpoint, and off once it is back within 0.2 °C.',
    explodeOffset: [0,.5,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'BlowerFan_HeatSink',
    label: 'BlowerFan_HeatSink',
    meshNames: ['BlowerFan_HeatSink'],
    description: 'Heat sink that sits with the blower fan and carries heat away from the thermal parts so the air stream can dissipate it.',
    explodeOffset: [0,.5,-.1],
    labelAnchor: [0,0,0],
  },
    {
    id: 'Wiring',
    label: 'Wiring',
    meshNames: ['Wiring'],
    description: 'Power and signal wiring that connects the ESP32 to the sensors, heater, Peltier, fan and humidifier.',
    explodeOffset: [0,0,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'Wiring3',
    label: 'Wiring3',
    meshNames: ['Wiring3'],
    description: 'Power and signal wiring that connects the ESP32 to the sensors, heater, Peltier, fan and humidifier.',
    explodeOffset: [0,0,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'Wiring2',
    label: 'Wiring2',
    meshNames: ['Wiring2'],
    description: 'Additional wiring run that routes power from the Power Supply',
    explodeOffset: [0,0,0],
    labelAnchor: [0,0,0],
  },
    {
    id: 'HeatSink',
    label: 'HeatSink',
    meshNames: ['HeatSink.001', 'HeatSink', 'Heatsink'],
    description: 'Finned aluminium heat sink that moves heat away from the Peltier module so it can cool the chamber efficiently.',
    explodeOffset: [0,.5,0],
    labelAnchor: [0,0,0],
  },
]

export const HIGHLIGHT_COLOR = '#2f5d50'
