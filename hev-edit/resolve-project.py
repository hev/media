#!/usr/bin/env python3
"""Bounded Resolve import/export using the video kit's Studio connection."""
import json
import sys
import time
from pathlib import Path

folder, name, media_root, kit = sys.argv[1:]
folder = Path(folder)
# Only our job/revision namespace may be replaced.
import re
if not re.fullmatch(r'[a-z0-9-]+-[a-f0-9-]{36}-r[1-9][0-9]*', name):
    sys.exit('Invalid project name')
sys.path.insert(0, kit)
from resolve_build import resolve
app = None
for _ in range(30):
    app = resolve()
    if app:
        break
    time.sleep(1)
if not app:
    print('Resolve Studio is not reachable; enable Local scripting and start Studio', file=sys.stderr)
    sys.exit(3)
pm = app.GetProjectManager()
current = pm.GetCurrentProject()
if current:
    if current.GetName() != name and not pm.SaveProject():
        sys.exit('Could not save current Resolve project; refusing to switch')
    if not pm.CloseProject(current):
        sys.exit('Could not close current project safely')
pm.DeleteProject(name)
project = pm.CreateProject(name)
if not project:
    sys.exit('Could not create job project')
cut = json.loads((folder / 'cut.json').read_text())
for key, value in {'timelineResolutionWidth':cut['width'], 'timelineResolutionHeight':cut['height'], 'timelineFrameRate':cut['fps']}.items():
    if not project.SetSetting(key, str(value)):
        sys.exit('Could not set ' + key)
pool = project.GetMediaPool()
tl = pool.ImportTimelineFromFile(str(folder / 'timeline.fcpxml'), {'timelineName':name, 'importSourceClips':True})
if not tl:
    sys.exit('Resolve rejected the FCPXML')
project.SetCurrentTimeline(tl)
expected=[round(c['out']*cut['fps'])-round(c['in']*cut['fps']) for c in cut['clips']]
items=tl.GetItemListInTrack('video',1)
if tl.GetStartFrame()!=0 or len(items)!=len(expected) or [c.GetDuration() for c in items]!=expected or tl.GetEndFrame()!=sum(expected):
    sys.exit('Resolve imported incorrect timeline ranges; refusing to export')

used = set()
for kind in ('video', 'audio'):
    for track in range(1, tl.GetTrackCount(kind)+1):
        for item in tl.GetItemListInTrack(kind,track) or []:
            media = item.GetMediaPoolItem()
            if media:
                used.add(Path(media.GetClipProperty('File Path')).name)
extras = [str(p) for p in (Path(media_root)/'media').glob('*') if p.name not in used]
if extras:
    bin_ = pool.AddSubFolder(pool.GetRootFolder(),'Extras')
    if not bin_:
        sys.exit('Could not create Extras bin')
    pool.SetCurrentFolder(bin_)
    if not pool.ImportMedia(extras):
        sys.exit('Could not import extras')
    pool.SetCurrentFolder(pool.GetRootFolder())
if not pm.SaveProject() or not pm.ExportProject(name,str(folder/(name+'.drp')),False):
    sys.exit('Could not save/export job project')
proof = {'name':name,'width':tl.GetSetting('timelineResolutionWidth'),'height':tl.GetSetting('timelineResolutionHeight'),'fps':tl.GetSetting('timelineFrameRate'),'clips':[{'name':c.GetName(),'start':c.GetStart(),'end':c.GetEnd(),'duration':c.GetDuration(),'source':c.GetMediaPoolItem().GetClipProperty('File Path')} for c in tl.GetItemListInTrack('video',1)],'extras':extras}
(folder/'resolve-proof.json').write_text(json.dumps(proof,indent=2))
print(json.dumps(proof))
