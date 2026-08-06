import assert from 'node:assert';
import { parseResultsCsv } from '../apps/web/src/lib/resultsCsv';

const CSV = [
  'epoch,time,train/box_loss,train/cls_loss,train/l1_loss,metrics/precision(B),metrics/recall(B),metrics/mAP50(B),metrics/mAP50-95(B),val/box_loss,val/cls_loss,val/l1_loss,lr/pg0,lr/pg1,lr/pg2',
  '1,16.5437,1.21207,6.12768,0.00591,0.01156,0.58651,0.05327,0.04398,0.78645,4.93134,0.00563,5.63448e-05,5.63448e-05,5.63448e-05',
  '2,32.5891,0.79285,3.86731,0.00364,0.52714,0.24378,0.27854,0.22796,0.74178,3.2519,0.00525,0.000112553,0.000112553,0.000112553',
].join('\n');

const parsed = parseResultsCsv(CSV);
assert.deepStrictEqual(parsed.epochs, [1, 2], 'epochs');
assert.strictEqual(parsed.series.trainBoxLoss![0], 1.21207, 'trainBoxLoss e1');
assert.strictEqual(parsed.series.valBoxLoss![1], 0.74178, 'valBoxLoss e2');
assert.strictEqual(parsed.series.map50![0], 0.05327, 'mAP50(B) matched by prefix');
assert.strictEqual(parsed.series.map5095![1], 0.22796, 'mAP50-95(B)');
assert.strictEqual(parsed.series.precision![0], 0.01156, 'precision(B)');
assert.strictEqual(parsed.series.recall![1], 0.24378, 'recall(B)');
assert.strictEqual(parsed.series.trainClsLoss![0], 6.12768, 'trainClsLoss');
assert.ok(!('trainL1Loss' in parsed.series), 'l1_loss not mapped');

const empty = parseResultsCsv('epoch,x\n');
assert.deepStrictEqual(empty.epochs, [], 'empty csv');

console.log('resultsCsv self-check OK');
