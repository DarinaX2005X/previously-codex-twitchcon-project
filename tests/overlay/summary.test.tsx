import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {SceneSummary} from '../../src/features/overlay/ScenePlayer.js';
import {planFixture} from './fixture.js';

describe('narrow scene summary',()=>{
  it('retains a neutral context-only focal record when no now field is supported',()=>{
    const plan=planFixture();plan.beats=[{...plan.beats[0],kind:'context',text:'The studio is taking listener requests'}];
    const html=renderToStaticMarkup(<SceneSummary plan={plan}/>);
    expect(html).toContain('scene-summary-current');expect(html).toContain('Stream context');expect(html).toContain(plan.beats[0].text);expect(html).not.toContain('What matters now');
  });
  it('keeps actual now as focal when historical context follows in data order',()=>{
    const plan=planFixture();plan.beats=[plan.beats[2],{...plan.beats[0],kind:'context'}];
    const html=renderToStaticMarkup(<SceneSummary plan={plan}/>);
    expect(html).toContain('<p class="scene-summary-current"><span>What matters now</span>Testing the reconnect fix</p>');
    expect(html.match(/class="scene-summary-current"/g)).toHaveLength(1);
  });
});
