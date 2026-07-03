<template>
  <section class="legend">
    <h2>图例</h2>
    <div class="item"><span class="line track"></span>程序航迹</div>
    <div class="item"><span class="line to-dme"></span>入航至 13D VJB</div>
    <div class="item"><span class="line entry"></span>进入 11D ARC 转弯</div>
    <div class="item"><span class="line arc"></span>11 DME ARC</div>
    <div class="item"><span class="line exit"></span>Lead Radial 退出转弯</div>
    <div class="item"><span class="line final"></span>RDL340 / 160° 公共段</div>
    <div class="item"><span class="line lead"></span>L-R332 / L-R348</div>
    <div class="item"><span class="line radial"></span>径向参考</div>
    <div class="item"><span class="arrow"></span>飞行方向</div>
    <div class="item"><span class="dot fix"></span>航路点 / 跑道点</div>
    <div class="item"><span class="dot derived"></span>派生点 / 需复核</div>
  </section>
</template>

<style scoped>
.legend {
  display: grid;
  gap: 8px;
}

h2 {
  margin: 0;
  color: #172033;
  font-size: 14px;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #475569;
  font-size: 12px;
  line-height: 1.35;
}

.line {
  width: 28px;
  height: 0;
  border-top: 3px solid #64748b;
}

.track {
  border-color: #315b87;
}

.to-dme {
  border-color: #246bd6;
}

.entry {
  border-color: #8b4fd1;
}

.arc {
  border-color: #168a54;
}

.exit,
.lead {
  border-color: #f06c2f;
  border-top-style: dashed;
}

.final {
  border-color: #d22d37;
}

.radial {
  border-color: #566071;
  border-top-style: dashed;
}

.arrow {
  position: relative;
  width: 24px;
  height: 18px;
}

.arrow::before {
  content: "";
  position: absolute;
  left: 4px;
  top: 2px;
  width: 0;
  height: 0;
  border-left: 8px solid transparent;
  border-right: 8px solid transparent;
  border-bottom: 16px solid #111827;
  transform: rotate(90deg);
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid #246bd6;
  background: #ffffff;
}

.derived {
  border-color: #92400e;
  background: #facc15;
}
</style>
