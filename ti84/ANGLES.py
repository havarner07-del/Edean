from math import *

def gcd(a,b):
  a=abs(a);b=abs(b)
  while b:
    a,b=b,a%b
  return a

def fr(x):
  s=1
  if x<0:
    s=-1;x=-x
  h0,h1,k0,k1=0,1,1,0
  y=x
  for i in range(20):
    t=int(y)
    h0,h1=h1,t*h1+h0
    k0,k1=k1,t*k1+k0
    if k1>1000:
      return None
    if abs(h1/k1-x)<=1e-9*max(1,x):
      return (s*h1,k1)
    if y-t<1e-12:
      return None
    y=1/(y-t)
  return None

def fmt(x):
  if isinstance(x,int):
    return str(x)
  f=fr(x)
  if f:
    if f[1]==1:
      return str(f[0])
    return str(f[0])+"/"+str(f[1])
  return str(round(x,4))

def num(p):
  while True:
    s=input(p).replace(" ","")
    try:
      if "/" in s:
        a,b=s.split("/")
        x=float(a)/float(b)
      else:
        x=float(s)
      if x==int(x):
        return int(x)
      return x
    except:
      print("Try again")

def wait():
  input("[enter]")

def rpi(dg):
  f=fr(dg/180)
  if not f:
    return fmt(dg*pi/180)
  n,d=f
  if n==0:
    return "0"
  s="pi" if abs(n)==1 else str(abs(n))+"pi"
  if n<0:
    s="-"+s
  if d!=1:
    s=s+"/"+str(d)
  return s

def pang(s):
  s=s.replace(" ","").lower()
  if "pi" in s:
    s=s.replace("pi","").replace("*","")
    if s=="" or s[0]=="/":
      s="1"+s
    elif s[0]=="-" and (len(s)==1 or s[1]=="/"):
      s="-1"+s[1:]
    if "/" in s:
      a,b=s.split("/")
      return 180*float(a)/float(b)
    return 180*float(s)
  if s.endswith("r"):
    return float(s[:-1])*180/pi
  return float(s)

def ang(p="Angle: "):
  print("deg: 150  rad: 5pi/6 or 2r")
  while True:
    try:
      return pang(input(p))
    except:
      print("Try again")

def quad(t):
  t=t%360
  if t%90==0:
    return "on an axis"
  return "Quadrant "+"I II III IV".split()[int(t//90)]

def refa(t):
  t=t%360
  if t<=90:
    return t
  if t<=180:
    return 180-t
  if t<=270:
    return t-180
  return 360-t

def dms():
  print("1 D M S -> decimal deg")
  print("2 decimal deg -> D M S")
  if num("? ")==1:
    d=num("deg=");m=num("min=");s=num("sec=")
    print("= "+str(round(d+m/60+s/3600,6))+" deg")
  else:
    x=num("deg=");sg="-" if x<0 else "";x=abs(x)
    d=int(x);m=int((x-d)*60);s=round(((x-d)*60-m)*60,2)
    if s>=60:
      s=0;m+=1
    print("= "+sg+str(d)+"deg "+str(m)+"' "+str(s)+"\"")

def pf(x):
  f=fr(x/pi)
  if f and f[1]<=100 and f[0]!=0:
    return rpi(x*180/pi)+" ~ "+str(round(x,4))
  return fmt(x)

def conv():
  t=ang()
  print("= "+fmt(t)+" deg")
  print("= "+rpi(t)+" rad")
  print("~ "+str(round(t*pi/180,5))+" rad")

def info():
  t=ang()
  print(fmt(t)+" deg = "+rpi(t)+" rad")
  print(quad(t))
  p=t%360
  print("Coterminal: "+fmt(p)+" deg")
  print(" +360: "+fmt(p+360)+"  -360: "+fmt(p-360))
  print(" rad: "+rpi(p)+", "+rpi(p+360)+", "+rpi(p-360))
  r=refa(t)
  print("Reference: "+fmt(r)+" = "+rpi(r))
  if 0<t<90:
    print("Complement: "+fmt(90-t)+" = "+rpi(90-t))
  if 0<t<180:
    print("Supplement: "+fmt(180-t)+" = "+rpi(180-t))

def arc():
  print("Enter 0 for the unknown")
  r=num("radius r=")
  print("theta: 0 if unknown,")
  print(" 60 = deg, pi/3 = rad")
  s0=input("theta: ").strip()
  if s0=="0":
    s=num("arc length s=")
    th=s/r
    print("theta = s/r = "+fmt(th)+" rad")
    print(" = "+fmt(th*180/pi)+" deg")
  else:
    th=pang(s0)*pi/180
    if r==0:
      s=num("arc length s=")
      r=s/th
      print("r = s/theta = "+pf(r))
    else:
      s=r*th
      print("s = r*theta = "+pf(s))
      print(" (theta in radians!)")
  print("Area = 1/2 r^2 theta")
  print(" = "+pf(r*r*th/2))

def speed():
  r=num("radius r=")
  print("1 know rev per time")
  print("2 know omega (rad/time)")
  if num("? ")==1:
    w=num("rev per time=")*2*pi
  else:
    w=num("omega=")
  print("omega = "+fmt(w/pi)+"pi rad/time")
  print(" ~ "+str(round(w,4))+" rad/time")
  print("v = r*omega = "+fmt(r*w/pi)+"pi")
  print(" ~ "+str(round(r*w,4))+" units/time")
  print("(convert units if needed)")

def form():
  print("rad = deg * pi/180")
  print("deg = rad * 180/pi")
  print("1 deg = 60' , 1' = 60\"")
  print("Arc s = r*theta (rad)")
  print("Sector A = 1/2 r^2 theta")
  print("v = r*omega, omega = th/t")
  print("1 rev = 2pi rad = 360 deg")
  print("Compl: add to 90 (pi/2)")
  print("Suppl: add to 180 (pi)")
  wait()

while True:
  print("== ANGLES (4.1) ==")
  print("1 Deg <-> Rad")
  print("2 DMS <-> decimal")
  print("3 Coterminal/reference")
  print("4 Arc length & sector")
  print("5 Linear/angular speed")
  print("6 Formulas  0 Quit")
  c=num("? ")
  if c==0:
    break
  print("")
  try:
    [0,conv,dms,info,arc,speed,form][c]()
  except Exception as x:
    print("Error: "+str(x))
  wait()
