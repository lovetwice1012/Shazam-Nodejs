# Shazam-NodeJs

This project is a Node.js implementation of the Shazam audio fingerprinting algorithm. It allows you to recognize songs from audio data using the Shazam API.
It is rewritten from the original Python implementation by [Numenorean/ShazamAPI](https://github.com/Numenorean/ShazamAPI).

## Table of Contents

- [Shazam-NodeJs](#shazam-nodejs)
  - [Table of Contents](#table-of-contents)
  - [Installation](#installation)
  - [Usage](#usage)
  - [Classes](#classes)
    - [Shazam](#shazam)
      - [Constructor](#constructor)
      - [Methods](#methods)
    - [DecodedMessage](#decodedmessage)
      - [Methods](#methods-1)
    - [FrequencyPeak](#frequencypeak)
      - [Constructor](#constructor-1)
      - [Methods](#methods-2)
    - [Endpoint](#endpoint)
      - [Constructor](#constructor-2)
      - [Properties](#properties)
    - [RingBuffer](#ringbuffer)
      - [Constructor](#constructor-3)
      - [Methods](#methods-3)
    - [SignatureGenerator](#signaturegenerator)
      - [Constructor](#constructor-4)
      - [Methods](#methods-4)
  - [License](#license)

## Installation

To use this project, you need to have Node.js installed on your system. You can install the required dependencies using npm or yarn:

```sh
# Using npm
npm install fft-js base64-js node-fetch uuid

# Using yarn
yarn add fft-js base64-js node-fetch uuid
```

## Usage

Below is an example of how to use the Shazam signature generator and recognizer in your Node.js application.

```javascript
const { Shazam } = require('./path/to/Shazam.js'); // Adjust the path as necessary
const fs = require('fs');

(async () => {
  const songData = fs.readFileSync('path/to/your/audio/file'); // Adjust the path to your audio file

  const shazam = new Shazam(songData);
  const results = await shazam.recognizeSong();

  results.forEach(([offset, result]) => {
    console.log(`Offset: ${offset}s`);
    console.log('Result:', result);
  });
})();
```

## Classes

### Shazam

The `Shazam` class is the main entry point for recognizing songs.

#### Constructor

```javascript
new Shazam(songData, lang = 'ja', timeZone = 'Asia/Tokyo')
```

- `songData`: A buffer containing the audio data.
- `lang`: The language code (default is 'ja').
- `timeZone`: The time zone (default is 'Asia/Tokyo').

#### Methods

- `recognizeSong()`: Recognizes the song from the provided audio data. Returns a list of results with offsets.

### DecodedMessage

The `DecodedMessage` class represents a decoded audio message.

#### Methods

- `decodeFromBinary(data)`: Decodes a message from binary data.
- `decodeFromUri(uri)`: Decodes a message from a URI.
- `encodeToJson()`: Encodes the message to JSON format.
- `encodeToBinary()`: Encodes the message to binary format.
- `encodeToUri()`: Encodes the message to a URI.

### FrequencyPeak

The `FrequencyPeak` class represents a peak in the frequency domain.

#### Constructor

```javascript
new FrequencyPeak(fftPassNumber, peakMagnitude, correctedPeakFrequencyBin, sampleRateHz)
```

- `fftPassNumber`: The FFT pass number.
- `peakMagnitude`: The peak magnitude.
- `correctedPeakFrequencyBin`: The corrected peak frequency bin.
- `sampleRateHz`: The sample rate in Hz.

#### Methods

- `getFrequencyHz()`: Returns the frequency in Hz.
- `getAmplitudePcm()`: Returns the amplitude in PCM format.
- `getSeconds()`: Returns the time in seconds.

### Endpoint

The `Endpoint` class represents an endpoint for Shazam's API.

#### Constructor

```javascript
new Endpoint(lang, timeZone)
```

- `lang`: The language code.
- `timeZone`: The time zone.

#### Properties

- `url`: The endpoint URL.
- `params`: The request parameters.
- `headers`: The request headers.

### RingBuffer

The `RingBuffer` class represents a circular buffer.

#### Constructor

```javascript
new RingBuffer(bufferSize, defaultValue = null)
```

- `bufferSize`: The size of the buffer.
- `defaultValue`: The default value to fill the buffer with.

#### Methods

- `append(value)`: Appends a value to the buffer.

### SignatureGenerator

The `SignatureGenerator` class generates signatures from audio data.

#### Constructor

```javascript
new SignatureGenerator()
```

#### Methods

- `feedInput(samples)`: Feeds samples to the generator.
- `getNextSignature()`: Gets the next signature.
- `processInput(samples)`: Processes the input samples.
- `doFft(samples)`: Performs FFT on the samples.
- `doPeakSpreadingAndRecognition()`: Spreads and recognizes peaks.
- `doPeakSpreading()`: Spreads the peaks.
- `doPeakRecognition()`: Recognizes the peaks.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
