/*
  PidController.h - discrete PID controller for the BioPod chamber (header only).

  Form (parallel / "ideal", gains in physical units):

      u(k) = Kp*e(k)  +  I(k)  -  Kd * dMeasFiltered(k)

      e(k)   = setpoint - measurement
      I(k)   = I(k-1) + Ki*e(k)*dt              (Ki = Kp/Ti, units: % per (degC*s))
      dMeas  = first-order low-pass of (meas(k) - meas(k-1))/dt

  Design choices (each one avoids a classic real-world failure):
    * Derivative acts on the MEASUREMENT, not the error -> no output "kick" when the
      setpoint is changed from the dashboard.
    * The derivative is low-pass filtered (time constant tf) -> the 0.1 degC
      quantisation / noise of a DHT22 is not amplified into the heater duty.
    * Conditional-integration anti-windup: the integrator is frozen while the output
      is saturated AND the error is still pushing further into saturation. The
      integrator is also clamped to the output range.
    * No Arduino dependency, so the exact same file can be unit-tested on a PC.

  The Python optimiser (tools/pso_tune.py) contains a line-for-line mirror of
  update(); keep the two in sync if you change either one.
*/
#pragma once
#include <math.h>

class PidController {
 public:
  PidController(float kp, float ki, float kd, float outMin, float outMax, float derivFilterS)
      : kp_(kp), ki_(ki), kd_(kd), outMin_(outMin), outMax_(outMax), tf_(derivFilterS) {}

  void setGains(float kp, float ki, float kd) { kp_ = kp; ki_ = ki; kd_ = kd; }

  // Output limits can change at run time (e.g. cooling not allowed yet -> outMin = 0).
  void setOutputLimits(float outMin, float outMax) { outMin_ = outMin; outMax_ = outMax; }

  // Forget everything (use when control was off for a long time).
  void reset() { integral_ = 0; dFilt_ = 0; haveLast_ = false; }

  // Forget only the derivative history (use after a sensor dropout, so the first
  // sample back does not look like a huge temperature step).
  void resetDerivative() { dFilt_ = 0; haveLast_ = false; }

  // One control step. dt in seconds. Returns the clamped output in [outMin, outMax].
  float update(float setpoint, float measurement, float dt) {
    const float e = setpoint - measurement;

    float dMeas = 0.0f;
    if (haveLast_ && dt > 0.0f) dMeas = (measurement - lastMeas_) / dt;
    dFilt_ += (dt / (tf_ + dt)) * (dMeas - dFilt_);
    lastMeas_ = measurement;
    haveLast_ = true;

    pTerm = kp_ * e;
    dTerm = -kd_ * dFilt_;
    const float iCandidate = integral_ + ki_ * e * dt;
    const float raw = pTerm + iCandidate + dTerm;
    const float out = clampf(raw, outMin_, outMax_);

    const bool pushingIntoSaturation = (raw > outMax_ && e > 0.0f) || (raw < outMin_ && e < 0.0f);
    if (!pushingIntoSaturation) integral_ = clampf(iCandidate, outMin_, outMax_);
    iTerm = integral_;
    return out;
  }

  // Last computed terms, handy for telemetry / debugging.
  float pTerm = 0, iTerm = 0, dTerm = 0;

 private:
  static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
  float kp_, ki_, kd_, outMin_, outMax_, tf_;
  float integral_ = 0, dFilt_ = 0, lastMeas_ = 0;
  bool haveLast_ = false;
};
