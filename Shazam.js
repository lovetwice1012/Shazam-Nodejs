const { createHash } = require('crypto');
const { fromByteArray, toByteArray } = require('base64-js');
const { Readable } = require('stream');
const { promisify } = require('util');
const zlib = require('zlib');
const uuid = require('uuid');
const fetch = require('node-fetch');
const fft = require('fft-js').fft;
const hanning = require('fft-js').util.hanning;

const DATA_URI_PREFIX = 'data:audio/vnd.shazam.sig;base64,';
const LANG = 'ja';
const TIME_ZONE = 'Asia/Tokyo';
const HANNING_MATRIX = hanning(2048);

const SampleRate = Object.freeze({
  _8000: 1,
  _11025: 2,
  _16000: 3,
  _32000: 4,
  _44100: 5,
  _48000: 6,
});

const FrequencyBand = Object.freeze({
  _0_250: -1,
  _250_520: 0,
  _520_1450: 1,
  _1450_3500: 2,
  _3500_5500: 3,
});

class FrequencyPeak {
  constructor(fftPassNumber, peakMagnitude, correctedPeakFrequencyBin, sampleRateHz) {
    this.fftPassNumber = fftPassNumber;
    this.peakMagnitude = peakMagnitude;
    this.correctedPeakFrequencyBin = correctedPeakFrequencyBin;
    this.sampleRateHz = sampleRateHz;
  }

  getFrequencyHz() {
    return this.correctedPeakFrequencyBin * (this.sampleRateHz / 2 / 1024 / 64);
  }

  getAmplitudePcm() {
    return Math.sqrt(Math.exp((this.peakMagnitude - 6144) / 1477.3) * (1 << 17) / 2) / 1024;
  }

  getSeconds() {
    return (this.fftPassNumber * 128) / this.sampleRateHz;
  }
}

class DecodedMessage {
  constructor() {
    this.sampleRateHz = null;
    this.numberSamples = null;
    this.frequencyBandToSoundPeaks = {};
  }

  static decodeFromBinary(data) {
    const buf = Buffer.from(data);
    const checksummableData = buf.slice(8);
    const header = buf.slice(0, 48);

    const magic1 = header.readUInt32LE(0);
    const crc32 = header.readUInt32LE(4);
    const sizeMinusHeader = header.readUInt32LE(8);
    const magic2 = header.readUInt32LE(12);
    const shiftedSampleRateId = header.readUInt32LE(28);

    if (magic1 !== 0xcafe2580 || sizeMinusHeader !== data.length - 48 || createHash('crc32').update(checksummableData).digest('hex') !== crc32.toString(16) || magic2 !== 0x94119c00) {
      throw new Error('Invalid signature header');
    }

    const self = new DecodedMessage();
    self.sampleRateHz = parseInt(Object.keys(SampleRate).find(key => SampleRate[key] === (shiftedSampleRateId >> 27)).substring(1));
    self.numberSamples = Math.round(header.readUInt32LE(44) - self.sampleRateHz * 0.24);

    let offset = 48;
    while (offset < data.length) {
      const frequencyBandId = buf.readUInt32LE(offset);
      const frequencyPeaksSize = buf.readUInt32LE(offset + 4);
      offset += 8;

      const frequencyPeaks = [];
      for (let i = 0; i < frequencyPeaksSize; i++) {
        const fftPassNumber = buf.readUInt8(offset + i);
        const peakMagnitude = buf.readUInt16LE(offset + i + 1);
        const correctedPeakFrequencyBin = buf.readUInt16LE(offset + i + 3);
        frequencyPeaks.push(new FrequencyPeak(fftPassNumber, peakMagnitude, correctedPeakFrequencyBin, self.sampleRateHz));
      }

      self.frequencyBandToSoundPeaks[FrequencyBand[frequencyBandId - 0x60030040]] = frequencyPeaks;
      offset += frequencyPeaksSize + (-frequencyPeaksSize % 4);
    }

    return self;
  }

  static decodeFromUri(uri) {
    if (!uri.startsWith(DATA_URI_PREFIX)) {
      throw new Error('Invalid data URI prefix');
    }
    const data = toByteArray(uri.replace(DATA_URI_PREFIX, ''));
    return this.decodeFromBinary(data);
  }

  encodeToJson() {
    return {
      sample_rate_hz: this.sampleRateHz,
      number_samples: this.numberSamples,
      _seconds: this.numberSamples / this.sampleRateHz,
      frequency_band_to_peaks: Object.keys(this.frequencyBandToSoundPeaks).reduce((acc, band) => {
        acc[band.replace(/^_/, '')] = this.frequencyBandToSoundPeaks[band].map(peak => ({
          fft_pass_number: peak.fftPassNumber,
          peak_magnitude: peak.peakMagnitude,
          corrected_peak_frequency_bin: peak.correctedPeakFrequencyBin,
          _frequency_hz: peak.getFrequencyHz(),
          _amplitude_pcm: peak.getAmplitudePcm(),
          _seconds: peak.getSeconds(),
        }));
        return acc;
      }, {}),
    };
  }

  encodeToBinary() {
    const header = Buffer.alloc(48);
    header.writeUInt32LE(0xcafe2580, 0);
    header.writeUInt32LE(0x94119c00, 12);
    header.writeUInt32LE(this.sampleRateHz << 27, 28);
    header.writeUInt32LE(((15 << 19) + 0x40000), 44);
    header.writeUInt32LE(this.numberSamples + this.sampleRateHz * 0.24, 44);

    const contents = Object.keys(this.frequencyBandToSoundPeaks).map(band => {
      const peaks = this.frequencyBandToSoundPeaks[band];
      const peaksBuf = Buffer.concat(peaks.map(peak => {
        const buf = Buffer.alloc(5);
        buf.writeUInt8(peak.fftPassNumber, 0);
        buf.writeUInt16LE(peak.peak_magnitude, 1);
        buf.writeUInt16LE(peak.corrected_peak_frequency_bin, 3);
        return buf;
      }));
      return Buffer.concat([Buffer.from([(0x60030040 + FrequencyBand[band]) >> 0]), Buffer.from([peaksBuf.length]), peaksBuf, Buffer.alloc(-peaksBuf.length % 4)]);
    });

    const totalSize = contents.reduce((acc, buf) => acc + buf.length, 0) + 8;
    header.writeUInt32LE(totalSize, 8);

    const buf = Buffer.concat([header, ...contents]);
    const crc32 = createHash('crc32').update(buf.slice(8)).digest('hex');
    header.writeUInt32LE(parseInt(crc32, 16), 4);

    return buf;
  }

  encodeToUri() {
    return DATA_URI_PREFIX + fromByteArray(this.encodeToBinary());
  }
}

class Endpoint {
  constructor(lang, timeZone) {
    this.lang = lang;
    this.timeZone = timeZone;
  }

  get url() {
    return `https://${Endpoint.HOSTNAME}/discovery/v5/${this.lang}/${this.lang.toUpperCase()}/iphone/-/tag/{uuid_a}/{uuid_b}`;
  }

  get params() {
    return {
      sync: 'true',
      webv3: 'true',
      sampling: 'true',
      connected: '',
      shazamapiversion: 'v3',
      sharehub: 'true',
      hubv5minorversion: 'v5.1',
      hidelb: 'true',
      video: 'v3',
    };
  }

  get headers() {
    return {
      'X-Shazam-Platform': 'IPHONE',
      'X-Shazam-AppVersion': '14.1.0',
      Accept: '*/*',
      'Accept-Language': this.lang,
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'Shazam/3685 CFNetwork/1197 Darwin/20.0.0',
    };
  }
}

class Shazam {
  constructor(songData, lang = LANG, timeZone = TIME_ZONE) {
    this.songData = songData;
    this.endpoint = new Endpoint(lang, timeZone);
  }

  async recognizeSong() {
    this.audio = await this.normalizeAudioData(this.songData);
    const signatureGenerator = this.createSignatureGenerator(this.audio);

    const results = [];
    let signature;
    while ((signature = signatureGenerator.getNextSignature())) {
      results.push(this.sendRecognizeRequest(signature));
    }

    return Promise.all(results);
  }

  async sendRecognizeRequest(sig) {
    const data = {
      timezone: this.endpoint.timeZone,
      signature: {
        uri: sig.encodeToUri(),
        samplems: Math.round(sig.numberSamples / sig.sampleRateHz * 1000),
      },
      timestamp: Date.now(),
      context: {},
      geolocation: {},
    };

    const response = await fetch(this.endpoint.url.replace('{uuid_a}', uuid.v4().toUpperCase()).replace('{uuid_b}', uuid.v4().toUpperCase()), {
      method: 'POST',
      headers: this.endpoint.headers,
      body: JSON.stringify(data),
    });

    return response.json();
  }

  async normalizeAudioData(songData) {
    const buffer = Buffer.from(songData);
    const audio = await Readable.from(buffer).pipe(zlib.createGunzip()).pipe(zlib.createDeflate());

    audio.setSampleWidth(2);
    audio.setFrameRate(16000);
    audio.setChannels(1);

    return audio;
  }

  createSignatureGenerator(audio) {
    const signatureGenerator = new SignatureGenerator();
    signatureGenerator.feedInput(audio.getArrayOfSamples());
    signatureGenerator.MAX_TIME_SECONDS = Shazam.MAX_TIME_SECONDS;
    if (audio.durationSeconds > 12 * 3) {
      signatureGenerator.samplesProcessed += 16000 * (Math.floor(audio.durationSeconds / 16) - 6);
    }
    return signatureGenerator;
  }
}

class RingBuffer extends Array {
  constructor(bufferSize, defaultValue = null) {
    super(bufferSize);
    this.position = 0;
    this.bufferSize = bufferSize;
    this.numWritten = 0;
    this.fill(defaultValue);
  }

  append(value) {
    this[this.position] = value;
    this.position = (this.position + 1) % this.bufferSize;
    this.numWritten++;
  }
}

class SignatureGenerator {
  constructor() {
    this.inputPendingProcessing = [];
    this.samplesProcessed = 0;

    this.ringBufferOfSamples = new RingBuffer(2048, 0);
    this.fftOutputs = new RingBuffer(256, new Array(1025).fill(0));
    this.spreadFftsOutput = new RingBuffer(256, new Array(1025).fill(0));

    this.MAX_TIME_SECONDS = 3.1;
    this.MAX_PEAKS = 255;

    this.nextSignature = new DecodedMessage();
    this.nextSignature.sampleRateHz = 16000;
    this.nextSignature.numberSamples = 0;
    this.nextSignature.frequencyBandToSoundPeaks = {};
  }

  feedInput(samples) {
    this.inputPendingProcessing.push(...samples);
  }

  getNextSignature() {
    if (this.inputPendingProcessing.length - this.samplesProcessed < 128) {
      return null;
    }

    while (this.inputPendingProcessing.length - this.samplesProcessed >= 128 && 
      (this.nextSignature.numberSamples / this.nextSignature.sampleRateHz < this.MAX_TIME_SECONDS ||
      Object.values(this.nextSignature.frequencyBandToSoundPeaks).reduce((acc, peaks) => acc + peaks.length, 0) < this.MAX_PEAKS)) {
      this.processInput(this.inputPendingProcessing.slice(this.samplesProcessed, this.samplesProcessed + 128));
      this.samplesProcessed += 128;
    }

    const returnedSignature = this.nextSignature;
    this.nextSignature = new DecodedMessage();
    this.nextSignature.sampleRateHz = 16000;
    this.nextSignature.numberSamples = 0;
    this.nextSignature.frequencyBandToSoundPeaks = {};

    this.ringBufferOfSamples = new RingBuffer(2048, 0);
    this.fftOutputs = new RingBuffer(256, new Array(1025).fill(0));
    this.spreadFftsOutput = new RingBuffer(256, new Array(1025).fill(0));

    return returnedSignature;
  }

  processInput(samples) {
    this.nextSignature.numberSamples += samples.length;

    for (let i = 0; i < samples.length; i += 128) {
      this.doFft(samples.slice(i, i + 128));
      this.doPeakSpreadingAndRecognition();
    }
  }

  doFft(samples) {
    const pos = this.ringBufferOfSamples.position;
    this.ringBufferOfSamples.splice(pos, samples.length, ...samples);
    this.ringBufferOfSamples.position = (pos + samples.length) % 2048;
    this.ringBufferOfSamples.numWritten += samples.length;

    const excerpt = [...this.ringBufferOfSamples.slice(this.ringBufferOfSamples.position), ...this.ringBufferOfSamples.slice(0, this.ringBufferOfSamples.position)];
    const fftResults = fft(HANNING_MATRIX.map((val, idx) => val * excerpt[idx])).map(c => c[0] ** 2 + c[1] ** 2).map(val => Math.max(val, 1e-10));

    this.fftOutputs.append(fftResults);
  }

  doPeakSpreadingAndRecognition() {
    this.doPeakSpreading();
    if (this.spreadFftsOutput.numWritten >= 46) {
      this.doPeakRecognition();
    }
  }

  doPeakSpreading() {
    const lastFft = this.fftOutputs[this.fftOutputs.position - 1];
    const spreadFft = lastFft.slice();

    for (let i = 0; i < 1025; i++) {
      if (i < 1023) {
        spreadFft[i] = Math.max(spreadFft[i], spreadFft[i + 1], spreadFft[i + 2]);
      }
      let maxVal = spreadFft[i];
      [-1, -3, -6].forEach(offset => {
        const pos = (this.spreadFftsOutput.position + offset) % this.spreadFftsOutput.bufferSize;
        this.spreadFftsOutput[pos][i] = maxVal = Math.max(this.spreadFftsOutput[pos][i], maxVal);
      });
    }

    this.spreadFftsOutput.append(spreadFft);
  }

  doPeakRecognition() {
    const fftMinus46 = this.fftOutputs[(this.fftOutputs.position - 46) % this.fftOutputs.bufferSize];
    const fftMinus49 = this.spreadFftsOutput[(this.spreadFftsOutput.position - 49) % this.spreadFftsOutput.bufferSize];
    const fftMinus53 = this.spreadFftsOutput[(this.spreadFftsOutput.position - 53) % this.spreadFftsOutput.bufferSize];
    const fftMinus45 = this.spreadFftsOutput[(this.spreadFftsOutput.position - 45) % this.spreadFftsOutput.bufferSize];

    for (let i = 10; i < 1015; i++) {
      if (fftMinus46[i] >= 1 / 64 && fftMinus46[i] >= fftMinus49[i - 1]) {
        let maxNeighborInFftMinus49 = 0;
        [-10, -3, 1, 2, 5, 8].forEach(offset => {
          maxNeighborInFftMinus49 = Math.max(fftMinus49[i + offset], maxNeighborInFftMinus49);
        });

        if (fftMinus46[i] > maxNeighborInFftMinus49) {
          let maxNeighborInOtherAdjacentFfts = maxNeighborInFftMinus49;
          [-53, -45, 165, 201, 214, 250].forEach(offset => {
            maxNeighborInOtherAdjacentFfts = Math.max(this.spreadFftsOutput[(this.spreadFftsOutput.position + offset) % this.spreadFftsOutput.bufferSize][i - 1], maxNeighborInOtherAdjacentFfts);
          });

          if (fftMinus46[i] > maxNeighborInOtherAdjacentFfts) {
            const fftNumber = this.spreadFftsOutput.numWritten - 46;
            const peakMagnitude = Math.log(Math.max(1 / 64, fftMinus46[i])) * 1477.3 + 6144;
            const peakMagnitudeBefore = Math.log(Math.max(1 / 64, fftMinus46[i - 1])) * 1477.3 + 6144;
            const peakMagnitudeAfter = Math.log(Math.max(1 / 64, fftMinus46[i + 1])) * 1477.3 + 6144;
            const peakVariation1 = peakMagnitude * 2 - peakMagnitudeBefore - peakMagnitudeAfter;
            const peakVariation2 = (peakMagnitudeAfter - peakMagnitudeBefore) * 32 / peakVariation1;
            const correctedPeakFrequencyBin = i * 64 + peakVariation2;

            if (peakVariation1 > 0) {
              const frequencyHz = correctedPeakFrequencyBin * (16000 / 2 / 1024 / 64);

              if (frequencyHz >= 250) {
                let band;
                if (frequencyHz < 520) band = FrequencyBand._250_520;
                else if (frequencyHz < 1450) band = FrequencyBand._520_1450;
                else if (frequencyHz < 3500) band = FrequencyBand._1450_3500;
                else if (frequencyHz <= 5500) band = FrequencyBand._3500_5500;
                else continue;

                if (!this.nextSignature.frequencyBandToSoundPeaks[band]) {
                  this.nextSignature.frequencyBandToSoundPeaks[band] = [];
                }

                this.nextSignature.frequencyBandToSoundPeaks[band].push(new FrequencyPeak(fftNumber, Math.floor(peak_magnitude), Math.floor(corrected_peak_frequency_bin), 16000));
              }
            }
          }
        }
      }
    }
  }
}

module.exports = { Shazam, DecodedMessage, FrequencyPeak, Endpoint, RingBuffer, SignatureGenerator };
