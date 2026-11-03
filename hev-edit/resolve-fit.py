#!/usr/bin/env python3
"""Separate alpha padding plates keep fit shots editable on V1 in Resolve."""
import json,subprocess,sys
from pathlib import Path
folder=Path(sys.argv[1]);cut=json.loads((folder/'cut.json').read_text());w,h,fps=cut['width'],cut['height'],cut['fps'];at=0
for i,c in enumerate(cut['clips']):
    duration=(round(c['out']*fps)-round(c['in']*fps))/fps
    if c.get('fit')=='fit':
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',str(folder/c['src'])]))['streams'][0]
        sw,sh=probe['width'],probe['height'];scale=min(w/sw,h/sh);fw,fh=round(sw*scale),round(sh*scale)
        x,y=(w-fw)//2,(h-fh)//2;blur=max(1,min(40,min(w,h)//4))
        rel=f'graphics/fit-{i:02d}.mov';(folder/'graphics').mkdir(exist_ok=True)
        filters=f'[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur={blur}:5,format=rgb24[bg];color=white:s={w}x{h}:r={fps},drawbox=x={x}:y={y}:w={fw}:h={fh}:color=black:t=fill,format=gray[mask];[bg][mask]alphamerge[v]'
        subprocess.run(['ffmpeg','-v','error','-nostdin','-y','-ss',str(c['in']),'-i',str(folder/c['src']),'-t',str(duration),'-filter_complex',filters,'-map','[v]','-an','-r',str(fps),'-c:v','qtrle',str(folder/rel)],check=True)
        cut['overlays'].append({'comp':'FitBackground','file':rel,'start':at,'end':at+duration})
    at+=duration
(folder/'cut.json').write_text(json.dumps(cut,indent=2))
