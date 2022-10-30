export class MyAudioContext{
    async initialize(){
        this.audioContext = new AudioContext({
            sampleRate: 20000,
            latencyHint: "playback"
        });
        this.audioContext.suspend();
    }

    async play() {
        return this.audioContext.resume();
      }
    
      async pause() {
        return this.audioContext.suspend();
      }
      getMediaTimeInSeconds() {
        // The currently rendered audio sample is the current time of the
        // AudioContext, offset by the total output latency, that is composed of
        // the internal buffering of the AudioContext (e.g., double buffering), and
        // the inherent latency of the audio playback system: OS buffering,
        // hardware buffering, etc. This starts out negative, because it takes some
        // time to buffer, and crosses zero as the first audio sample is produced
        // by the audio output device.
        //当前渲染的音频样本是AudioContext的当前时间，抵消了总输出延迟，
        //它由AudioContext的内部缓冲（例如，双缓冲）和音频播放系统的固有延迟组成：
        //OS 缓冲，硬件缓冲等。这开始是负数，因为它需要一些时间来缓冲，并且在音频输出设备产生第一个音频样本时越过零。
        console.log("audiocontext.outputlatency");
        console.log(this.audioContext.outputLatency);
        console.log("audiocontext.baselatency");
        console.log(this.audioContext.baseLatency);
        let totalOutputLatency =
            this.audioContext.outputLatency + this.audioContext.baseLatency;
    
        return Math.max(this.audioContext.currentTime - totalOutputLatency, 0.0);
      }
}