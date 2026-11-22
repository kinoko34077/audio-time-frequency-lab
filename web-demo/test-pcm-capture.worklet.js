class AudioLabTestPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs,outputs){
    const input=inputs[0]||[],output=outputs[0]||[];
    for(let channel=0;channel<output.length;channel++){
      const source=input[channel]||input[0];
      if(source)output[channel].set(source);
      else output[channel].fill(0);
    }
    const channels=input.map(source=>source.slice());
    this.port.postMessage({startFrame:currentFrame,channels},
      channels.map(channel=>channel.buffer));
    return true;
  }
}
registerProcessor("audio-lab-test-pcm-capture",AudioLabTestPcmCaptureProcessor);
