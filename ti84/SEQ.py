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

def lin(m,b):
  s=fmt(m)+"n"
  if b>0:
    s=s+" + "+fmt(b)
  elif b<0:
    s=s+" - "+fmt(-b)
  return s

def arith():
  print("1 know a1 and d")
  print("2 know two terms")
  c=num("? ")
  if c==1:
    a1=num("a1=");d=num("d=")
  else:
    m=num("term # m=");am=num("a_m value=")
    n=num("term # n=");an=num("a_n value=")
    d=(an-am)/(n-m);a1=am-(m-1)*d
  print("d = "+fmt(d)+"  a1 = "+fmt(a1))
  print("a_n = a1+(n-1)d")
  print("a_n = "+lin(d,a1-d))
  while True:
    print("1 find a_n & S_n  2 which")
    print("term is value?  0 back")
    c=num("? ")
    if c==1:
      n=num("n=");an=a1+(n-1)*d
      print("a_"+fmt(n)+" = "+fmt(an))
      print("S_n = n/2(a1+a_n)")
      print("S_"+fmt(n)+" = "+fmt(n*(a1+an)/2))
    elif c==2:
      n=(num("value=")-a1)/d+1
      if n==int(n) and n>0:
        print("It is term #"+str(int(n)))
      else:
        print("Not a term (n="+fmt(n)+")")
    else:
      return

def geo1(a1,r):
  print("r = "+fmt(r)+"  a1 = "+fmt(a1))
  print("a_n = "+fmt(a1)+"("+fmt(r)+")^(n-1)")
  if abs(r)<1:
    print("S_inf = a1/(1-r) = "+fmt(a1/(1-r)))
  else:
    print("S_inf: none, |r|>=1")
  while True:
    print("1 find a_n & S_n  0 back")
    if num("? ")!=1:
      return
    n=int(num("n="))
    print("a_"+str(n)+" = "+fmt(a1*r**(n-1)))
    print("S_n = a1(1-r^n)/(1-r)")
    s=n*a1 if r==1 else a1*(1-r**n)/(1-r)
    print("S_"+str(n)+" = "+fmt(s))

def geo():
  print("1 know a1 and r")
  print("2 know two terms")
  print("3 repeating decimal")
  c=num("? ")
  if c==1:
    geo1(num("a1="),num("r="))
  elif c==2:
    m=num("term # m=");am=num("a_m value=")
    n=num("term # n=");an=num("a_n value=")
    q=an/am;e=n-m
    x=abs(q)**(1/e)
    if q<0 and e%2==0:
      print("No real r")
      return
    if q<0:
      rs=[-x]
    elif e%2==0:
      rs=[x,-x]
      print("Two answers: r=+-"+fmt(x))
    else:
      rs=[x]
    for r in rs:
      geo1(am/r**(m-1),r)
  else:
    w=input("whole number part: ").strip() or "0"
    a=input("digits after . that\ndon't repeat (or blank): ").strip()
    b=input("repeating digits: ").strip()
    den=10**len(a)*(10**len(b)-1)
    nm=int(a+b)-int(a or "0")+int(w)*den
    g=gcd(nm,den)
    print("= "+str(nm//g)+"/"+str(den//g))
    print("as series: a1="+fmt(int(b)/10**(len(a)+len(b))))
    print(" r=1/"+str(10**len(b))+" S=a1/(1-r)")

def fix(e):
  e=e.replace("^","**").replace(" ","")
  o=""
  for i in range(len(e)):
    ch=e[i]
    if i>0:
      p=e[i-1]
      q=e[i-2] if i>1 else " "
      if (p.isdigit() and (ch.isalpha() or ch=="(")) or (p==")" and (ch.isalpha() or ch.isdigit() or ch=="(")) or (p in "na" and not q.isalpha() and (ch=="(" or ch.isdigit())):
        o=o+"*"
    o=o+ch
  return o

def ev(e,nv,av=0):
  global n,a
  n=nv;a=av
  return eval(e)

def anys():
  print("Use n, e.g. (-1)^n/(n+1)")
  e=fix(input("a_n = "))
  lo=int(num("start n="));hi=int(num("end n="))
  s=0;j=0
  for k in range(lo,hi+1):
    t=ev(e,k);s=s+t
    if j<20:
      print("a_"+str(k)+" = "+fmt(t))
    j=j+1
    if j%8==0 and j<20:
      wait()
  print("Sum = "+fmt(s))

def rec():
  print("Recursive: use a for the")
  print("previous term, e.g. 2a+1")
  a1=num("a1=");e=fix(input("a_n = "))
  hi=int(num("how many terms="))
  t=a1
  print("a_1 = "+fmt(t))
  for k in range(2,hi+1):
    t=ev(e,k,t)
    print("a_"+str(k)+" = "+fmt(t))

def ind():
  print("Check sum formula for")
  print("induction. Use n.")
  e=fix(input("term a_n = "))
  f=fix(input("formula S_n = "))
  s=0;ok=True
  for k in range(1,11):
    s=s+ev(e,k);g=ev(f,k)
    if abs(s-g)>1e-6*max(1,abs(s)):
      ok=False
      print("FAILS at n="+str(k)+": "+fmt(s)+" vs "+fmt(g))
      break
  if ok:
    print("True for n=1..10")
  print("Proof steps:")
  print("1 Base: n=1, a_1 = S_1")
  print("2 Assume S_k true")
  print("3 Show S_k + a_(k+1)")
  print("  = S_(k+1)")

def form():
  print("ARITH: a_n=a1+(n-1)d")
  print(" S_n=n/2(a1+a_n)")
  print(" S_n=n/2(2a1+(n-1)d)")
  print("GEOM: a_n=a1 r^(n-1)")
  print(" S_n=a1(1-r^n)/(1-r)")
  print(" S_inf=a1/(1-r) if |r|<1")
  wait()
  print("SUM i = n(n+1)/2")
  print("SUM i^2 = n(n+1)(2n+1)/6")
  print("SUM i^3 = n^2(n+1)^2/4")
  print("SUM c = cn")
  print("n! = 1*2*...*n, 0!=1")
  wait()

while True:
  print("== SEQUENCES (Ch 11) ==")
  print("1 Arithmetic")
  print("2 Geometric / repeat dec")
  print("3 Terms & sum of a_n")
  print("4 Recursive sequence")
  print("5 Induction check")
  print("6 Formulas  0 Quit")
  c=num("? ")
  if c==0:
    break
  print("")
  try:
    [0,arith,geo,anys,rec,ind,form][c]()
  except Exception as x:
    print("Error: "+str(x))
  wait()
