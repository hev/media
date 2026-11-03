#!/usr/bin/env python3
"""Correct connected-layer offsets for source clips with embedded timecode."""
from fractions import Fraction
from pathlib import Path
import json,sys,xml.etree.ElementTree as ET
folder=Path(sys.argv[1]);cut=json.loads((folder/'cut.json').read_text());file=folder/'out/timeline.fcpxml';tree=ET.parse(file)
def rational(value):return Fraction(value.removesuffix('s'))
def stamp(value):return f'{value.numerator}/{value.denominator}s'
parents=tree.findall('.//spine/asset-clip')
for parent,clip in zip(parents,cut['clips']):
    delta=rational(parent.get('start','0s'))-Fraction(round(clip['in']*cut['fps']),cut['fps'])
    lane=0
    for child in parent.findall('asset-clip'):
        child.set('offset',stamp(rational(child.get('offset','0s'))+delta))
        if int(child.get('lane','0'))>0:
            lane+=1;child.set('lane',str(lane))
tree.write(file,encoding='utf-8',xml_declaration=True)
